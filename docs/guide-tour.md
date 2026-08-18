# Guide me tour

Guide me is a fixed presentation sequence, not a second analytical workflow.
It starts from an unobstructed OpenStreetMap basemap, draws the dissolved
Zennevallei boundary, introduces its seven municipalities from north to south,
and then replays four already validated Landsat heatwave observations.

The dates are 13 June 2023, 9 September 2023, 13 August 2025 and 22 June 2026.
The introductory frame lists the matching official heatwave periods. The final
frame makes clear that the 22 June image is one observation within the complete
17–28 June 2026 event, then presents four short KMI/IRM facts: its 12-day
duration, seven days above 30°C, the 39.4°C national maximum measured at
Ophoven on 26 June and the 24.1°C highest minimum during a Uccle heatwave.
Press sources and health claims are intentionally absent from the tour; one
quiet link opens the official language-specific KMI/IRM June report.
After the fourth fact appears, the closing sentence makes clear that this is a
test animation and that future versions of Guide me will reveal more insights.
The four facts, 2026 observation and temperature legend remain visible behind
that final invitation to explore the map.

The tour reads the same PMTiles archives and temperature legend as the normal
Heatwave surface-temperature map. It does not interpolate, alter or recalculate
any scientific value.

Raster frames are swapped only after their source is ready. The geography stays
visible until the first frame is ready, and subsequent observations crossfade
between two alternating raster slots. The next archive header is prefetched
while the current frame is visible, and the last stable frame remains on screen
if a request fails. A generation token cancels stale loads on Exit or replay.
The tour pauses when the browser tab is hidden and uses instant boundary
reveals and transitions when reduced motion is requested.
