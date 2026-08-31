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
  row.innerHTML = `<span class="name">${name}</span><input type="range"><span class="val" tabindex="0" title="click to type a value"></span>`;
  const input = row.querySelector("input")!;
  const val = row.querySelector(".val") as HTMLSpanElement;
  Object.assign(input, { min, max, step, value });
  const show = () => (val.textContent = fmt(+input.value));
  const commit = (v: number) => {
    const clamped = Math.min(max, Math.max(min, v));
    input.value = clamped as unknown as string; // DOM coerces numbers; keep the raw assign
    show();
    onInput(clamped);
  };
  input.addEventListener("input", () => {
    show();
    onInput(+input.value);
  });

  // Click the number to type an exact value instead of dragging.
  const startEdit = () => {
    const edit = document.createElement("input");
    edit.type = "number";
    edit.className = "val-edit";
    edit.min = String(min);
    edit.max = String(max);
    edit.step = String(step);
    edit.value = String(+input.value);
    val.replaceWith(edit);
    edit.focus();
    edit.select();
    let done = false; // replaceWith() below detaches edit, which re-fires blur
    const stop = (apply: boolean) => {
      if (done) return;
      done = true;
      if (apply) {
        const v = Number(edit.value);
        if (Number.isFinite(v)) commit(v);
      }
      edit.replaceWith(val);
    };
    edit.addEventListener("keydown", (e) => {
      if (e.key === "Enter") stop(true);
      else if (e.key === "Escape") stop(false);
    });
    edit.addEventListener("blur", () => stop(true));
  };
  val.addEventListener("click", startEdit);
  val.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      startEdit();
    }
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

// Dropdown bound to a string value (for pickers that would drown in buttons).
export function selectRow(
  parent: HTMLElement,
  name: string,
  options: { value: string; label: string }[],
  value: string,
  onChange: (v: string) => void,
): {
  set(v: string): void;
  refresh(opts: { value: string; label: string }[]): void;
} {
  const row = document.createElement("div");
  row.className = "slider-row";
  row.innerHTML = `<span class="name">${name}</span><select class="sel"></select>`;
  const sel = row.querySelector("select")!;
  const fill = (opts: { value: string; label: string }[]) => {
    sel.innerHTML = "";
    for (const o of opts) {
      const el = document.createElement("option");
      el.value = o.value;
      el.textContent = o.label;
      sel.appendChild(el);
    }
  };
  fill(options);
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  parent.appendChild(row);
  return {
    set: (v) => (sel.value = v),
    refresh: (opts) => {
      const old = sel.value;
      fill(opts);
      sel.value = opts.some((o) => o.value === old)
        ? old
        : (opts[0]?.value ?? "");
    },
  };
}

// Multi-line text bound to a string (mood/description authoring).
export function textRow(
  parent: HTMLElement,
  name: string,
  value: string,
  onChange: (v: string) => void,
  rows = 3,
): { set(v: string): void } {
  const box = document.createElement("div");
  box.className = "text-row";
  box.innerHTML = `<div class="name">${name}</div><textarea rows="${rows}"></textarea>`;
  const area = box.querySelector("textarea")!;
  area.value = value;
  area.addEventListener("input", () => onChange(area.value));
  parent.appendChild(box);
  return { set: (v) => (area.value = v) };
}
