# Fruit Game - the ring and the light (Phase C)

The page draws and animates; **it never decides anything**. The server returns the rounds of a spin (`rounds`: `[[stop]]`, or `[[stop],[a],[b],[c]]` for 3 free spins, or `[[stop],[a,b,c]]` for a free spin with 3 lit cells) before anything is shown; the page then makes a light run round the ring and stop on exactly those cells.

* **Ring** (`public/js/fruit/table.js`): 24 cells round a 7 x 7 border (46 px tiles, 366 x 366 drawing), numbered clockwise from the top left; the 5 x 5 centre is free for the win and the bets. `test/fruit.test.js` checks that the cells and their order are those of the maths (`docs/fruit/verify_play.py`) and that the loop closes.
* **Pictures** (`art.js`): apple, orange, lemon, watermelon, bell, star, 7, BAR (a single plate and a triple plate), the two Lucky cells and the x3 badge, all drawn for this project as flat vector shapes (no outside artwork).
* **Light** (`anim.js`): `plan(rounds)` gives a timed list of events: a light runs one cell at a time, clockwise, 2-3 laps for the first stop and one for a free spin, slowing down (42 ms a cell at full speed, 330 ms for the last) and stopping on the server's cell; a Lucky stop flashes; three lights run together for a free spin with 3 lit cells. Laps and speeds are cosmetic and random; the end cell is not.
* **Drawing** (`view.js`): `FruitView.create(svg).draw(scene)` shows the running light, the cells that stay lit, a gold frame on cells that paid, and the credits bet on each symbol; it only touches what changed.

The page (Phase D) joins these to the API of `API.md`. Tests: `node test/fruit.test.js`.
