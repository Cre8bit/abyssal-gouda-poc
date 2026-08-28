// ui.ts — the tiny DOM control kit shared by the bench pages (preview.ts,
// worldgen.ts). Pure DOM helpers, no three.js: buttons, labeled sliders,
// number fields, color swatches, section headers. Styling comes from the
// host page's stylesheet (.section/.row/.slider-row classes).

export function button(
  parent: HTMLElement,
  label: string,
  onClick: (btn: HTMLButtonElement) => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.textContent = label;
  btn.addEventListener("click", () => onClick(btn));
  parent.appendChild(btn);
  return btn;
}

export interface SliderHandle {
  row: HTMLDivElement;
  set(v: number): void;
}

export function sliderRow(
  parent: HTMLElement,
  name: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onInput: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(2),
): SliderHandle {
  const row = document.createElement("div");
  row.className = "slider-row";
  row.innerHTML = `<span class="name">${name}</span><input type="range"><span class="val"></span>`;
  const input = row.querySelector("input")!;
  const val = row.querySelector(".val")!;
  Object.assign(input, { min, max, step, value });
  const show = () => (val.textContent = fmt(+input.value));
  input.addEventListener("input", () => {
    show();
    onInput(+input.value);
  });
  show();
  parent.appendChild(row);
  return {
    row,
    set(v: number) {
      input.value = v as unknown as string; // DOM coerces numbers; keep the raw assign
      show();
    },
  };
}

export function section(parent: HTMLElement, label: string): HTMLElement {
  const s = document.createElement("div");
  s.className = "section";
  s.innerHTML = `<div class="label">${label}</div><div class="row"></div>`;
  parent.appendChild(s);
  return s.querySelector(".row") as HTMLElement;
}

// Free-typed number field (for values a slider range would strangle: seeds).
export function numRow(
  parent: HTMLElement,
  name: string,
  value: number,
  onInput: (v: number) => void,
): { set(v: number): void } {
  const row = document.createElement("div");
  row.className = "slider-row";
  row.innerHTML = `<span class="name">${name}</span><input type="number" class="num">`;
  const input = row.querySelector("input")!;
  input.value = String(value);
  input.addEventListener("change", () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) onInput(v);
  });
  parent.appendChild(row);
  return { set: (v: number) => (input.value = String(v)) };
}

// Color swatch bound to a 0xRRGGBB number.
export function colorRow(
  parent: HTMLElement,
  name: string,
  value: number,
  onInput: (hex: number) => void,
): { set(hex: number): void } {
  const row = document.createElement("div");
  row.className = "slider-row";
  row.innerHTML = `<span class="name">${name}</span><input type="color"><span class="val"></span>`;
  const input = row.querySelector("input")!;
  const val = row.querySelector(".val")!;
  const show = (hex: number) => {
    input.value = `#${hex.toString(16).padStart(6, "0")}`;
    val.textContent = input.value;
  };
  show(value);
  input.addEventListener("input", () => {
    val.textContent = input.value;
    onInput(parseInt(input.value.slice(1), 16));
  });
  parent.appendChild(row);
  return { set: show };
}

export function markOn(
  btns: Record<string, HTMLButtonElement>,
  active: string,
): void {
  for (const [k, b] of Object.entries(btns))
    b.classList.toggle("on", k === active);
}
