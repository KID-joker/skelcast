export const devtoolsCSS = `
:host {
  font: 12px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #e4e4e7;
  color-scheme: dark;
  -webkit-font-smoothing: antialiased;
  --surface: #18181b;
  --border: #303034;
  --muted: #a1a1aa;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
button, select, input, textarea { font: inherit; color: inherit; }
button, select, input, textarea, summary { outline: none; }
button, select { min-height: 30px; border: 1px solid var(--border); border-radius: 6px; background: #222225; padding: 5px 9px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; white-space: nowrap; }
button:hover { background: #303034; border-color: #45454b; color: #fafafa; }
button:disabled { opacity: .4; cursor: wait; }
button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible {
  outline: 2px solid #a1a1aa; outline-offset: 3px;
}
svg { display: block; width: 15px; height: 15px; flex: none; pointer-events: none; }
.bar {
  display: flex; align-items: center; gap: 12px; padding: 6px 8px 6px 12px;
  max-width: calc(100vw - 36px); border: 1px solid #38383d; border-radius: 10px;
  background: var(--surface); box-shadow: 0 4px 16px #0002, 0 16px 48px #0002;
}
.title { display: flex; align-items: center; gap: 8px; padding-right: 2px; white-space: nowrap; font-weight: 600; letter-spacing: -.3px; }
.brand-mark { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid #45454b; border-radius: 6px; color: #d4d4d8; }
.brand-mark svg { width: 14px; height: 14px; }
.controls { display: flex; align-items: center; gap: 2px; min-width: 0; padding-left: 10px; border-left: 1px solid var(--border); }
.select-control { display: flex; position: relative; align-items: center; min-width: 0; margin: 0; gap: 0; }
.select-control > svg { position: absolute; left: 8px; color: #8b8b95; width: 14px; height: 14px; }
.select-control select {
  appearance: none; cursor: pointer; border-color: transparent; background: transparent;
  padding: 5px 23px 5px 29px; max-width: 174px; width: 100%; text-overflow: ellipsis;
}
.select-control select:hover { background: #27272b; }
.select-control::after { content: ''; position: absolute; right: 9px; width: 4px; height: 4px; border: solid #71717a; border-width: 0 1px 1px 0; transform: translateY(-2px) rotate(45deg); pointer-events: none; }
.region-control select, .variant-control select { font-family: var(--mono); font-size: 11px; }
.variant-control select { max-width: 104px; padding-left: 9px; color: var(--muted); }
.select-control.is-active > svg { color: #6ee7b7; }
.select-control.is-active select { color: #a7f3d0; }
.bar-actions { display: flex; gap: 3px; align-items: center; border-left: 1px solid var(--border); padding-left: 8px; }
.comparison-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 6px; padding: 8px 12px; border: 1px solid #38383d; border-radius: 8px; background: var(--surface); color: var(--muted); font-size: 11px; }
.comparison-bar label { margin: 0; gap: 8px; }
.comparison-bar input[type="range"] { width: 100px; padding: 0; accent-color: #a7f3d0; cursor: pointer; }
.comparison-bar output { min-width: 30px; font-family: var(--mono); text-align: right; }
.icon-button { width: 30px; padding: 0; background: transparent; border-color: transparent; color: var(--muted); }
.icon-button[aria-pressed="true"], .icon-button[aria-expanded="true"] { background: #303034; color: #fafafa; border-color: #3f3f46; }
#play:not([aria-pressed="true"]) { color: #e4e4e7; }
.panel {
  width: min(392px, calc(100vw - 36px)); max-height: min(640px, calc(100dvh - 130px)); overflow: auto;
  margin: 0 0 8px auto; padding: 18px; background: var(--surface); border: 1px solid #38383d;
  border-radius: 12px; box-shadow: 0 8px 24px #0002, 0 24px 64px #0002;
  scrollbar-width: thin; scrollbar-color: #45454b transparent; overflow-wrap: anywhere;
}
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 5px; }
h3 { font-size: 13px; font-weight: 600; letter-spacing: -.2px; margin: 0; }
.eyebrow { color: #8b8b95; font: 10px/1.5 var(--mono); letter-spacing: .7px; text-transform: uppercase; }
.region-name { margin: 0 0 16px; color: #a1a1aa; font: 11px/1.6 var(--mono); }
p { margin: 8px 0; color: var(--muted); }
.state-card { padding: 10px 12px; margin-bottom: 14px; background: #202023; border: 1px solid var(--border); border-radius: 7px; }
.state-card p { margin: 0; font-size: 11px; line-height: 1.8; }
.state-card strong { color: #d4d4d8; font-weight: 500; }
.badge { display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: #6ee7b7; }
.badge.warning { background: #e9b76c; }
label { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 10px 0; color: #d4d4d8; }
input, textarea { background: #111113; border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; font-family: var(--mono); font-size: 11px; }
input { width: 84px; }
input[type="checkbox"] { appearance: none; position: relative; flex: none; width: 28px; height: 16px; margin: 0; padding: 0; border-radius: 10px; background: #3f3f46; cursor: pointer; }
input[type="checkbox"]::after { content: ''; position: absolute; left: 3px; top: 3px; width: 8px; height: 8px; border-radius: 50%; background: #a1a1aa; }
input[type="checkbox"]:checked { background: #a7f3d0; border-color: #a7f3d0; }
input[type="checkbox"]:checked::after { left: 15px; background: #16352b; }
textarea { display: block; width: 100%; height: 90px; margin-top: 6px; resize: vertical; line-height: 1.6; tab-size: 2; }
.actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 12px 0; }
.actions button { font-size: 11px; }
#save { background: #e4e4e7; color: #18181b; border-color: #e4e4e7; font-weight: 600; }
#save:hover { background: #fafafa; }
.active { border-color: #6ee7b7; color: #a7f3d0; }
details { border-top: 1px solid var(--border); }
summary { display: flex; align-items: center; gap: 8px; padding: 12px 0; list-style: none; cursor: pointer; color: #b8b8c1; font-size: 11px; font-weight: 500; }
summary::-webkit-details-marker { display: none; }
summary::before { content: ''; width: 5px; height: 5px; margin: 0 2px; border: solid #71717a; border-width: 0 1px 1px 0; transform: rotate(-45deg); }
details[open] > summary::before { transform: translateY(-2px) rotate(45deg); }
summary:hover { color: #fafafa; }
details > p:first-of-type { margin-top: 0; font-size: 11px; }
.diagnostic { background: #222225; border-left: 2px solid #b99461; border-radius: 0 5px 5px 0; padding: 10px; margin: 8px 0; overflow-wrap: anywhere; font-size: 11px; }
.diagnostic strong { font-family: var(--mono); font-size: 10px; color: #e9b76c; }
.diagnostic button { margin: 6px 4px 0 0; }
.notice { color: #e9c883; padding: 10px 12px; background: #e9b76c0a; border: 1px solid #e9b76c30; border-radius: 6px; overflow-wrap: anywhere; }
small { font-size: 11px; color: #8b8b95; }
a { color: #a7f3d0; }
.repair { border: 1px solid #675238; border-radius: 7px; padding: 12px; margin: 14px 0; }
.repair h4 { margin: 6px 0; font-size: 12px; font-weight: 600; }
.repair pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; background: #111113; padding: 10px; border: 1px solid var(--border); border-radius: 5px; font: 11px/1.6 var(--mono); }
.repair-example { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 8px; }
@media (max-width: 900px) {
  .bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; padding: 8px; width: min(392px, calc(100vw - 36px)); }
  .title { padding-left: 4px; }
  .bar-actions { grid-column: 2; grid-row: 1; border: 0; padding: 0; }
  .controls { grid-column: 1 / -1; grid-row: 2; padding: 6px 0 0; border-left: 0; border-top: 1px solid var(--border); }
  .controls { flex-wrap: wrap; }
  .select-control { flex: 1; }
  .select-control select { min-width: 0; max-width: none; font-size: 11px; padding-left: 25px; padding-right: 18px; }
  .select-control > svg { left: 6px; width: 12px; height: 12px; }
  .select-control::after { right: 6px; }
  .variant-control { flex: 0 1 72px; }
  .variant-control select { padding-left: 7px; }
  .comparison-control { flex: 1 0 100%; border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px; }
  .panel { max-height: calc(100dvh - 156px); padding: 16px; }
}
@media (prefers-reduced-motion: no-preference) {
  button, select { transition: background .15s, border-color .15s, color .15s; }
  input[type="checkbox"]::after { transition: left .15s; }
}
`;
