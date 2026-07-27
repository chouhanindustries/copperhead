"""copperhead side panel for pcbnew (issue #114 Phase B, AC-114B).

KiCad 9/10 action plugin (the SWIG plugin system; removed in KiCad 11,
where this addon does not install — see the repo's issue #114 for the 11+
story). Registers a toolbar action that docks/toggles the copperhead pane.

pcbnew is only importable inside KiCad; the guard keeps this package
importable elsewhere (protocol smoke tests drive client.py directly, D3).
"""

import os

try:
    import pcbnew
except ImportError:
    pcbnew = None

if pcbnew is not None:

    class CopperheadPanelAction(pcbnew.ActionPlugin):
        def defaults(self):
            self.name = "copperhead"
            self.category = "AI agent"
            self.description = "Dock the copperhead agent panel (spec-gated, ERC/DRC-verified edits)"
            self.show_toolbar_button = True
            self.icon_file_name = os.path.join(os.path.dirname(__file__), "icon.png")

        def Run(self):
            # Imported lazily so a wx/panel failure surfaces on click (where
            # KiCad shows it) instead of poisoning plugin discovery at startup.
            from .panel import toggle_panel

            toggle_panel()

    CopperheadPanelAction().register()
