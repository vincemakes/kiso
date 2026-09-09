# @vincemakes/kiso-tui-cells

The pure cell renderer under kiso's terminal UI: the components
(containers, folding, the spinner, the settled row), the diff renderer
for write_file / edit_file results, display-width measurement, the
ground resolver (the terminal's background colour from its OSC reply and
the palette that follows it), and the strings the panels and banners are
built from. Zero runtime dependencies: input is data, output is bytes;
no terminal is touched here.

`@vincemakes/kiso-tui` composes these into the live screen; the CLI
(`@vincemakes/kiso-code`) is the consumer. See the repository README for
the framework overview.
