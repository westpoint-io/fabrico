# The v9.0 milestone done-test

The five leg sentences that `oneBoardAllFive.source.test.ts` (rule R8) requires, word for word,
in the header of `e2e-live/77-one-board-all-five.live.spec.ts`. Copied verbatim from the v9.0
requirements; leg 4 is read from its AMENDED line.

### The milestone done-test

One board, empty at the start. Every leg is walkable once the phases above land; none is walkable today. Legs
are routed so that no leg depends on capabilities from two different phases - that was v8.0's trap, where its
leg 3 needed a gesture, a dock and an inbox at once and shipped as a documented red.

1. **Place an HTTP Endpoint and an HTTP Handler from the palette, draw one wire between them, POST to the
   endpoint's URL, and get back a 200 whose body the JS in the Handler's own panel produced.** (phase 72)
2. **Place a Source, draw a belt from it, then press that belt's end nub and draw a second belt from there: the
   panel reads "This run is 2 belts." Set the run's downstream belt to its slowest pace and watch items pack
   solid tile by tile back through the junction.** (phase 74 - replaces the deliberately-red spec)
3. **Run that belt into a machine and slow the machine's outlet: the machine carries the backed-up mark, and the
   tile touching it stops emptying while the line packs backwards - then release and watch the jam clear from the
   front.** (phase 71)
4. **Resize that machine from 3x3 to 5x4, drop a Label beside the belt and type on it, then save, reload, and
   find the size, the text and the colour exactly as you left them, with items running past the label
   untouched.** (phases 76 and 77)

   **AMENDED 2026-10-06:** leg 4 now reads: **Drop a Label beside that belt, type on it and set its size and colour, then save,
   reload, and find the text, the size and the colour exactly as you left them, with items running past the label
   untouched.** (phase 76, Labels) The machine resize half moved with the footprints phase to SEED-261004-vfw.
5. **Press Disconnect on the wire from leg 1, then Ctrl+Z once: the cable comes back in the same place, routed
   head-on into both prongs, and no message appears at the top of the screen.** (phases 73 and 75)

