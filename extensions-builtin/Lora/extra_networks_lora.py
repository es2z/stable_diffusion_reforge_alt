from modules import extra_networks, shared, ui_extra_networks_stats
from modules_forge import lora_schedule
import networks


class ExtraNetworkLora(extra_networks.ExtraNetwork):
    def __init__(self):
        super().__init__('lora')

        self.errors = {}
        """mapping of network names to the number of errors the network had during operation"""

    remove_symbols = str.maketrans('', '', ":,")

    def activate(self, p, params_list):
        additional = shared.opts.sd_lora

        self.errors.clear()

        if additional != "None" and additional in networks.available_networks and not any(x for x in params_list if x.items[0] == additional):
            p.all_prompts = [x + f"<lora:{additional}:{shared.opts.extra_networks_default_multiplier}>" for x in p.all_prompts]
            params_list.append(extra_networks.ExtraNetworkParams(items=[additional, shared.opts.extra_networks_default_multiplier]))

        # tags inside prompt-editing brackets, like [<lora:a:0.8>:0.3]: the UNet gets them step by step
        # (modules_forge.lora_schedule); the text encoder runs before sampling, so it gets them as always
        scheduled = lora_schedule.scheduled_params(params_list) if shared.opts.lora_schedule_in_brackets else []
        scheduled_ids = {id(x) for x in scheduled}
        scheduled_unet = []
        scheduled_position = {}

        names = []
        te_multipliers = []
        unet_multipliers = []
        dyn_dims = []
        for params in params_list:
            assert params.items

            names.append(params.positional[0])

            te_multiplier = float(params.positional[1]) if len(params.positional) > 1 else 1.0
            te_multiplier = float(params.named.get("te", te_multiplier))

            unet_multiplier = float(params.positional[2]) if len(params.positional) > 2 else te_multiplier
            unet_multiplier = float(params.named.get("unet", unet_multiplier))

            dyn_dim = int(params.positional[3]) if len(params.positional) > 3 else None
            dyn_dim = int(params.named["dyn"]) if "dyn" in params.named else dyn_dim

            if id(params) in scheduled_ids:
                scheduled_unet.append((params.source_index, names[-1], unet_multiplier))
                unet_multiplier = 0.0

                # a network that stands in the brackets several times (a weight change, for one) is given
                # to the text encoder once, with the largest of its weights
                position = scheduled_position.get(names[-1])
                if position is not None:
                    names.pop()
                    if abs(te_multiplier) > abs(te_multipliers[position]):
                        te_multipliers[position] = te_multiplier
                    continue

                scheduled_position[names[-1]] = len(names) - 1

            te_multipliers.append(te_multiplier)
            unet_multipliers.append(unet_multiplier)
            dyn_dims.append(dyn_dim)

        networks.load_networks(names, te_multipliers, unet_multipliers, dyn_dims)

        entries = {}
        loaded = {x.mentioned_name: x for x in networks.loaded_networks}
        for index, name, unet_multiplier in scheduled_unet:
            net = loaded.get(name)
            if net is not None and unet_multiplier != 0:
                entries[index] = lora_schedule.Entry(name, net.network_on_disk.filename, net.mtime, unet_multiplier, lambda filename=net.network_on_disk.filename: networks.load_lora_state_dict(filename))

        p.lora_schedule = lora_schedule.Plan(scheduled[0].source_prompt, entries) if entries else None

        # usage count shown on the cards; counts whatever the generation uses, however it got into the prompt
        for item in networks.loaded_networks:
            ui_extra_networks_stats.record_use_once(p, "lora", item.network_on_disk.name)

        if shared.opts.lora_add_hashes_to_infotext:
            if not getattr(p, "is_hr_pass", False) or not hasattr(p, "lora_hashes"):
                p.lora_hashes = {}

            for item in networks.loaded_networks:
                if item.network_on_disk.shorthash and item.mentioned_name:
                    p.lora_hashes[item.mentioned_name.translate(self.remove_symbols)] = item.network_on_disk.shorthash

            if p.lora_hashes:
                p.extra_generation_params["Lora hashes"] = ', '.join(f'{k}: {v}' for k, v in p.lora_hashes.items())

    def deactivate(self, p):
        lora_schedule.finish()

        if self.errors:
            p.comment("Networks with errors: " + ", ".join(f"{k} ({v})" for k, v in self.errors.items()))

            self.errors.clear()
            