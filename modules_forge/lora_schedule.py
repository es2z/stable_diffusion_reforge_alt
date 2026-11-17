"""
Step-scheduled LoRA, written with the prompt-editing brackets that already schedule prompt text:

    [<lora:a:0.8>:0.3]                  a is added to the UNet from 30% of the steps
    [<lora:a:0.8>::0.3]                 a is removed from the UNet at 30%
    [foo:<lora:a:0.8>:0.3]              "foo" until 30%, a from then on
    [<lora:a:0.3>:<lora:a:0.8>:0.5]     the weight changes halfway
    [<lora:a:1>|<lora:b:1>]             alternates every step

The schedule is computed by modules.prompt_parser itself (the tags are swapped for placeholders first), so
a tag switches on the very step at which text at the same place in the brackets would.

Only the UNet follows the schedule. The weights of each state the schedule goes through are patched with
the hook functions of ModelPatcher; a patched state is kept (see lora_schedule_cache_states) and reused by
later steps, batches and generations for as long as the model and its always-on LoRAs stay the same.
"""
from __future__ import annotations

import itertools
import logging
import re
import weakref
from collections import OrderedDict

import lark

import ldm_patched.hooks
import ldm_patched.modules.lora
import ldm_patched.modules.lora_convert
from ldm_patched.modules import model_management
from modules import errors, shared

logger = logging.getLogger(__name__)

re_extra_net = re.compile(r"<(\w+):([^>]+)>")  # modules.extra_networks.re_extra_net
re_mark = re.compile("(\\d+)")

session = None
"""the sampling run that currently has hook weights in the model, if any"""

stores = weakref.WeakSet()


def hide_tags(prompt):
    """Replaces the nth extra network tag with a placeholder the prompt parser treats as plain text."""
    count = itertools.count()
    return re_extra_net.sub(lambda m: f"{next(count)}", prompt)


def scheduled_tags(prompt):
    """Indices (nth extra network tag of the prompt) of the tags inside [a:b:when] or [a|b]."""
    from modules import prompt_parser

    try:
        tree = prompt_parser.schedule_parser.parse(hide_tags(prompt))
    except lark.exceptions.LarkError:
        return set()  # the prompt parser does not schedule such a prompt either

    found = set()

    def walk(node, inside):
        if isinstance(node, lark.Tree):
            inside = inside or node.data in ("scheduled", "alternate")
            for child in node.children:
                walk(child, inside)
        elif inside and node is not None:
            found.update(int(x) for x in re_mark.findall(str(node)))

    walk(tree, False)
    return found


def scheduled_params(params_list):
    """The ExtraNetworkParams of params_list whose tag stands inside scheduling brackets."""
    prompt = next((x.source_prompt for x in params_list if getattr(x, "source_prompt", None)), None)
    if prompt is None or "[" not in prompt:
        return []

    indices = scheduled_tags(prompt)
    return [x for x in params_list if getattr(x, "source_prompt", None) == prompt and x.source_index in indices]


def cache_limit():
    return max(int(getattr(shared.opts, "lora_schedule_cache_states", 2) or 0), 0)


class Entry:
    """One scheduled tag."""

    def __init__(self, name, filename, mtime, strength, load):
        self.name = name
        self.filename = filename
        self.mtime = mtime
        self.strength = float(strength)
        self.load = load
        """returns the state dict of the file"""


class Plan:
    """The scheduled tags of one prompt. Attached to the processing object as p.lora_schedule."""

    def __init__(self, prompt, entries):
        self.prompt = prompt
        self.entries = entries
        """tag index -> Entry"""
        self.loaders = {(x.filename, x.mtime): x.load for x in entries.values()}
        self.schedules = {}

    def schedule(self, steps, hires_steps, use_old_scheduling):
        """[(end_at_step, state)]; a state is a sorted tuple of (filename, mtime, strength)."""
        key = (steps, hires_steps, use_old_scheduling)
        if key not in self.schedules:
            from modules import prompt_parser

            res = []
            for end_at_step, text in prompt_parser.get_learned_conditioning_prompt_schedules([hide_tags(self.prompt)], steps, hires_steps, use_old_scheduling)[0]:
                # tags of the same file that are active together are added up, like repeated tags outside brackets
                strengths = {}
                for index in re_mark.findall(text):
                    entry = self.entries.get(int(index))
                    if entry is not None:
                        strengths[(entry.filename, entry.mtime)] = strengths.get((entry.filename, entry.mtime), 0.0) + entry.strength

                res.append((end_at_step, tuple(sorted((*k, round(v, 6)) for k, v in strengths.items() if round(v, 6) != 0))))

            self.schedules[key] = res

        return self.schedules[key]

    def state_at(self, p, step):
        steps = getattr(p, "firstpass_steps", None) or p.steps
        hires_steps = None
        if getattr(p, "is_hr_pass", False):
            from modules import sd_samplers

            # same numbers as StableDiffusionProcessingTxt2Img.calculate_hr_conds
            sampler_config = sd_samplers.find_sampler_config(p.hr_sampler_name or p.sampler_name)
            hires_steps = p.hr_second_pass_steps or p.steps
            hires_steps = sampler_config.total_steps(hires_steps) if sampler_config else hires_steps

        schedule = self.schedule(steps, hires_steps, bool(shared.opts.use_old_scheduling))

        # same choice as prompt_parser.reconstruct_cond_batch
        target = 0
        for i, (end_at_step, _) in enumerate(schedule):
            if step <= end_at_step:
                target = i
                break

        return schedule[target][1]


class StateStore:
    """Patched weights of the states used lately, kept on the model they were computed for."""

    def __init__(self, patches_uuid):
        self.patches_uuid = patches_uuid
        self.states = OrderedDict()
        stores.add(self)

    def get(self, state):
        if state in self.states:
            self.states.move_to_end(state)
        return self.states.get(state)

    def put(self, state, weights, limit):
        """Returns the states that had to go."""
        self.states[state] = weights
        self.states.move_to_end(state)
        dropped = []
        while len(self.states) > limit:
            dropped.append(self.states.popitem(last=False)[0])
        return dropped


def store_for(unet):
    # the patched weights are built on the model's weights with the always-on patches in them, which is
    # what patches_uuid identifies
    store = getattr(unet.model, "lora_schedule_states", None)
    if store is None or store.patches_uuid != unet.patches_uuid:
        store = StateStore(unet.patches_uuid)
        unet.model.lora_schedule_states = store
    return store


class Session:
    """One sampling run on one ModelPatcher."""

    def __init__(self, plan, unet):
        self.plan = plan
        self.unet = unet
        self.store = store_for(unet)
        self.current = ()
        self.groups = {}
        self.hooks = {}
        self.patches = {}

    def group_for(self, state):
        group = self.groups.get(state)
        if group is None:
            group = ldm_patched.hooks.HookGroup()
            for item in state:
                if item not in self.hooks:
                    self.hooks[item] = ldm_patched.hooks.WeightHook()
                group.add(self.hooks[item])
            self.groups[state] = group
        return group

    def register(self, state):
        """Gives the ModelPatcher the patches of the state's hooks; needed only to compute weights."""
        unet = self.unet
        for item in state:
            hook = self.hooks[item]
            if hook.hook_ref in unet.hook_patches:
                continue

            filename, mtime, strength = item
            if filename not in self.patches:
                key_map = ldm_patched.modules.lora.model_lora_keys_unet(unet.model, {})
                lora = ldm_patched.modules.lora_convert.convert_lora(self.plan.loaders[(filename, mtime)]())
                self.patches[filename] = ldm_patched.modules.lora.load_lora(lora, key_map, log_missing=False)

            # add_hook_patches gives the patcher a new patches_uuid, which makes the next load_models_gpu
            # unpatch and repatch every weight. Hook patches are applied and removed here, not there.
            patches_uuid = unet.patches_uuid
            unet.add_hook_patches(hook=hook, patches=self.patches[filename], strength_patch=strength)
            unet.patches_uuid = patches_uuid

    def apply(self, state):
        if state == self.current:
            return

        unet = self.unet
        if not state:
            unet.patch_hooks(None)
            self.current = state
            return

        group = self.group_for(state)
        if group not in unet.cached_hook_patches:
            stored = self.store.get(state)
            if stored is not None:
                unet.cached_hook_patches[group] = stored
            else:
                self.register(state)

        try:
            unet.patch_hooks(group)
        except Exception:
            # weights of a half patched state must never be reused
            unet.cached_hook_patches.pop(group, None)
            self.store.states.pop(state, None)
            raise

        self.current = state

        limit = cache_limit()
        weights = unet.cached_hook_patches.get(group)
        if weights is not None:
            for dropped in self.store.put(state, weights, limit):
                if dropped in self.groups:
                    unet.cached_hook_patches.pop(self.groups[dropped], None)

    def close(self):
        unet = self.unet
        try:
            unet.patch_hooks(None)
        finally:
            for group in self.groups.values():
                unet.cached_hook_patches.pop(group, None)
            for hook in self.hooks.values():
                unet.hook_patches.pop(hook.hook_ref, None)


def before_step(denoiser):
    """Called by the denoiser before every model call: puts the weights of the current step in the UNet."""
    global session

    plan = getattr(getattr(denoiser, "p", None), "lora_schedule", None)
    if plan is None:
        if session is not None:
            finish()
        return

    unet = denoiser.inner_model.inner_model.forge_objects.unet
    if session is None or session.plan is not plan or session.unet is not unet:
        finish()
        session = Session(plan, unet)

    try:
        session.apply(plan.state_at(denoiser.p, denoiser.step))
    except Exception as e:
        errors.display(e, "applying scheduled Lora weights; the generation goes on without them")
        denoiser.p.lora_schedule = None
        finish()


def finish():
    """Takes the scheduled weights out of the UNet. Called whenever a sampling run ends, however it ends."""
    global session

    current, session = session, None
    if current is not None:
        current.close()


def release(device):
    """Called by model_management before it unloads models to make room: kept states go first."""
    if session is not None or model_management.is_device_cpu(device):
        return

    for store in list(stores):
        if store.states:
            logger.debug("lora schedule: releasing %d kept state(s)", len(store.states))
            store.states.clear()


model_management.memory_pressure_callbacks.append(release)
