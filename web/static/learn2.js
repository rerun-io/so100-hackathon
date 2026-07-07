// Layout v2 chrome condenser: scrolling past ENTER hides the site header and docks a
// compact stepper at the top (see .chrome / body.is-condensed in learn2.css). The wide
// gap between ENTER and EXIT is hysteresis: micro-scrolls, trackpad rubber-banding, and
// scroll-anchoring shifts (WASM viewers loading) can never flicker the state.
const ENTER = 96;
const EXIT = 24;

let condensed = false;
let ticking = false;

function update() {
  ticking = false;
  const y = window.scrollY;
  if (!condensed && y > ENTER) setCondensed(true);
  else if (condensed && y < EXIT) setCondensed(false);
}

function setCondensed(value) {
  condensed = value; // toggle only on change so CSS transitions fire exactly once
  document.body.classList.toggle("is-condensed", value);
}

window.addEventListener(
  "scroll",
  () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  },
  { passive: true },
);

update(); // correct state on load (anchor deep-links land mid-page)
