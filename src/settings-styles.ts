/** Styles for the plugin settings section. */
export const SETTINGS_CSS = `
.dsh-image-forge-settings {
  --dsh-settings-accent: var(--forge-accent, #e66a3a);
  --dsh-settings-ink: var(--forge-ink, currentColor);
  --dsh-settings-muted: color-mix(in srgb, currentColor 62%, transparent);
  --dsh-settings-line: color-mix(in srgb, currentColor 13%, transparent);
  --dsh-settings-soft: color-mix(in srgb, currentColor 4%, transparent);
  --dsh-settings-card: color-mix(in srgb, currentColor 1.5%, transparent);
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 1080px;
  padding-bottom: 4px;
  color: inherit;
  font: inherit;
  line-height: 1.5;
  container-type: inline-size;
  container-name: forge-settings;
}
.dsh-image-forge-settings * { box-sizing: border-box; }
.dsh-image-forge-settings button,
.dsh-image-forge-settings input,
.dsh-image-forge-settings select { font: inherit; }
.dsh-image-forge-settings button:focus-visible,
.dsh-image-forge-settings input:focus-visible,
.dsh-image-forge-settings select:focus-visible,
.dsh-image-forge-settings [role="log"]:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dsh-settings-accent) 70%, transparent);
  outline-offset: 2px;
}
.dsh-settings-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 2px 2px 0;
}
.dsh-settings-heading > div:first-child { min-width: 0; }
.dsh-settings-eyebrow {
  display: block;
  margin-bottom: 3px;
  color: var(--dsh-settings-muted);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.dsh-settings-title {
  margin: 0;
  color: var(--dsh-settings-ink);
  font-size: 20px;
  line-height: 1.25;
  letter-spacing: -.015em;
}
.dsh-settings-subtitle {
  max-width: 680px;
  margin: 5px 0 0;
  color: var(--dsh-settings-muted);
  font-size: 12.5px;
  line-height: 1.55;
}
.dsh-settings-heading-state {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
  flex: none;
}
.dsh-settings-heading-pill,
.dsh-settings-heading-meta {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
}
.dsh-settings-heading-pill {
  border: 1px solid color-mix(in srgb, #2f9e44 30%, var(--dsh-settings-line));
  background: color-mix(in srgb, #2f9e44 9%, transparent);
  color: color-mix(in srgb, #2f9e44 78%, currentColor);
}
.dsh-settings-heading-pill.is-dirty {
  border-color: color-mix(in srgb, var(--dsh-settings-accent) 38%, var(--dsh-settings-line));
  background: color-mix(in srgb, var(--dsh-settings-accent) 10%, transparent);
  color: var(--dsh-settings-accent);
}
.dsh-settings-heading-meta { color: var(--dsh-settings-muted); }
.dsh-image-forge-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
  padding: 4px;
  overflow-x: auto;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 12px;
  background: color-mix(in srgb, currentColor 3%, transparent);
  scrollbar-width: none;
}
.dsh-image-forge-tabs::-webkit-scrollbar { display: none; }
.dsh-image-forge-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 98px;
  min-height: 34px;
  padding: 5px 14px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--dsh-settings-muted);
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
}
.dsh-image-forge-tab:hover { color: var(--dsh-settings-ink); background: color-mix(in srgb, currentColor 4%, transparent); }
.dsh-image-forge-tab.is-active {
  color: var(--dsh-settings-ink);
  border-color: var(--dsh-settings-line);
  background: color-mix(in srgb, currentColor 7%, transparent);
  box-shadow: 0 1px 2px color-mix(in srgb, currentColor 7%, transparent);
}
.dsh-image-forge-tab-count {
  display: inline-grid;
  place-items: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--dsh-settings-accent);
  color: #fff;
  font-size: 10px;
  line-height: 1;
}
.dsh-image-forge-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 13px;
  min-width: 0;
}
.dsh-image-forge-settings-lead {
  margin: 0;
  padding: 0 2px;
  color: var(--dsh-settings-muted);
  font-size: 12px;
}
.dsh-settings-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 10px;
  background: var(--dsh-settings-soft);
  font-size: 12px;
}
.dsh-settings-banner.is-warning {
  border-color: color-mix(in srgb, #f08c00 35%, var(--dsh-settings-line));
  background: color-mix(in srgb, #f08c00 8%, transparent);
}
.dsh-settings-banner.is-error {
  border-color: color-mix(in srgb, #e03131 35%, var(--dsh-settings-line));
  background: color-mix(in srgb, #e03131 8%, transparent);
}
.dsh-settings-small,
.dsh-settings-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  padding: 5px 11px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 2.5%, transparent);
  color: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
}
.dsh-settings-small:hover,
.dsh-settings-action:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.dsh-settings-small.is-active {
  border-color: color-mix(in srgb, var(--dsh-settings-accent) 40%, var(--dsh-settings-line));
  background: color-mix(in srgb, var(--dsh-settings-accent) 10%, transparent);
  color: var(--dsh-settings-accent);
}
.dsh-settings-action.is-primary {
  min-height: 40px;
  padding-inline: 18px;
  border-color: var(--dsh-settings-accent);
  background: var(--dsh-settings-accent);
  color: #fff;
  font-weight: 650;
}
.dsh-settings-action.is-primary:hover { background: color-mix(in srgb, var(--dsh-settings-accent) 88%, #000); }
.dsh-settings-action.is-danger {
  color: color-mix(in srgb, #e03131 84%, currentColor);
  border-color: color-mix(in srgb, #e03131 30%, var(--dsh-settings-line));
}
.dsh-settings-small:disabled,
.dsh-settings-action:disabled,
.dsh-settings-reset-button:disabled { cursor: not-allowed; opacity: .45; }
.dsh-settings-environment {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 15px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 16px;
  background:
    radial-gradient(circle at 100% 0%, color-mix(in srgb, var(--dsh-settings-accent) 6%, transparent), transparent 34%),
    var(--dsh-settings-card);
  box-shadow: 0 1px 2px color-mix(in srgb, currentColor 5%, transparent);
}
.dsh-settings-environment[data-tone="is-bad"] {
  border-color: color-mix(in srgb, #e03131 23%, var(--dsh-settings-line));
}
.dsh-settings-environment-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}
.dsh-settings-environment-copy { min-width: 0; }
.dsh-settings-environment-title { margin: 0; font-size: 16px; line-height: 1.3; }
.dsh-settings-environment-note {
  max-width: 680px;
  margin: 5px 0 0;
  color: var(--dsh-settings-muted);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dsh-settings-environment-pills { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.dsh-settings-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 3px 9px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 999px;
  background: color-mix(in srgb, currentColor 4%, transparent);
  color: var(--dsh-settings-muted);
  font-size: 11px;
  white-space: nowrap;
}
.dsh-settings-state.is-ok { color: color-mix(in srgb, #2f9e44 80%, currentColor); border-color: color-mix(in srgb, #2f9e44 28%, var(--dsh-settings-line)); }
.dsh-settings-state.is-warn { color: color-mix(in srgb, #f08c00 84%, currentColor); border-color: color-mix(in srgb, #f08c00 28%, var(--dsh-settings-line)); }
.dsh-settings-state.is-bad { color: color-mix(in srgb, #e03131 84%, currentColor); border-color: color-mix(in srgb, #e03131 28%, var(--dsh-settings-line)); }
.dsh-settings-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent);
}
.dsh-settings-state.is-pending .dsh-settings-dot { animation: dsh-settings-pulse 1.2s ease-in-out infinite; }
.dsh-settings-environment-grid { display: flex; flex-direction: column; gap: 9px; }
.dsh-settings-facts {
  display: grid;
  grid-template-columns: minmax(70px, auto) minmax(0, 1fr);
  gap: 5px 10px;
  margin: 0;
  padding: 10px 11px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 10px;
  background: color-mix(in srgb, currentColor 2%, transparent);
  font-size: 11.5px;
}
.dsh-settings-facts dt { color: var(--dsh-settings-muted); }
.dsh-settings-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.dsh-settings-env-block,
.dsh-settings-inline-error,
.dsh-settings-inline-note {
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.45;
}
.dsh-settings-env-block { display: flex; flex-direction: column; gap: 2px; border: 1px solid color-mix(in srgb, #f08c00 30%, var(--dsh-settings-line)); background: color-mix(in srgb, #f08c00 7%, transparent); }
.dsh-settings-inline-error { border: 1px solid color-mix(in srgb, #e03131 30%, var(--dsh-settings-line)); background: color-mix(in srgb, #e03131 7%, transparent); color: color-mix(in srgb, #e03131 82%, currentColor); }
.dsh-settings-inline-note { border: 1px solid var(--dsh-settings-line); background: var(--dsh-settings-soft); color: var(--dsh-settings-muted); }
.dsh-settings-diagnostics { border-top: 1px solid var(--dsh-settings-line); padding-top: 7px; }
.dsh-settings-diagnostics > summary { cursor: pointer; color: var(--dsh-settings-muted); font-size: 11.5px; }
.dsh-settings-diagnostics p { margin: 7px 0 0; color: var(--dsh-settings-muted); font-size: 11.5px; overflow-wrap: anywhere; }
.dsh-settings-argv { display: block; max-height: 90px; margin-top: 7px; overflow: auto; padding: 7px; border-radius: 7px; background: var(--dsh-settings-soft); font-size: 10.5px; white-space: pre-wrap; word-break: break-all; }
.dsh-settings-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.dsh-settings-confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 9px 10px; border: 1px solid color-mix(in srgb, #e03131 28%, var(--dsh-settings-line)); border-radius: 10px; background: color-mix(in srgb, #e03131 6%, transparent); font-size: 12px; }
.dsh-settings-confirm > strong { width: 100%; }
.dsh-settings-confirm > span { flex: 1 1 260px; color: var(--dsh-settings-muted); }
.dsh-settings-confirm-actions { display: flex; gap: 6px; margin-left: auto; }
.dsh-settings-log { border-top: 1px solid var(--dsh-settings-line); padding-top: 9px; }
.dsh-settings-log-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-settings-log-toggle { display: inline-flex; align-items: center; gap: 7px; min-width: 0; padding: 4px 0; border: 0; background: transparent; color: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.dsh-settings-log-chevron { width: 12px; color: var(--dsh-settings-muted); }
.dsh-settings-log-source { max-width: 220px; overflow: hidden; color: var(--dsh-settings-muted); font-size: 10.5px; font-weight: 450; text-overflow: ellipsis; white-space: nowrap; }
.dsh-settings-log-actions { display: flex; gap: 5px; }
.dsh-settings-log-output {
  height: 210px;
  margin-top: 7px;
  overflow: auto;
  padding: 7px 0;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 9px;
  background: color-mix(in srgb, #111 93%, transparent);
  color: #e9e7df;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.55;
  scrollbar-width: thin;
}
.dsh-settings-log-output.is-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; padding: 18px; text-align: center; }
.dsh-settings-log-empty { max-width: 460px; color: #c8c4ba; }
.dsh-settings-log-empty-meta { color: #8f8b82; font-size: 10px; }
.dsh-settings-log-line { display: grid; grid-template-columns: 44px 74px minmax(0, 1fr); gap: 7px; padding: 1px 10px; }
.dsh-settings-log-line.is-error { background: color-mix(in srgb, #e03131 18%, transparent); color: #ffb4ab; }
.dsh-settings-log-line.is-warn { color: #ffd28a; }
.dsh-settings-log-no,
.dsh-settings-log-time { color: #8f8b82; font-variant-numeric: tabular-nums; }
.dsh-settings-log-text { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.dsh-settings-log-foot { margin-top: 5px; color: var(--dsh-settings-muted); font-size: 10.5px; }
.dsh-image-forge-settings-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 14px;
  background: var(--dsh-settings-card);
  box-shadow: 0 1px 2px color-mix(in srgb, currentColor 4%, transparent);
}
.dsh-image-forge-settings-group[data-advanced="true"] { background: color-mix(in srgb, currentColor 1%, transparent); }
.dsh-settings-group-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dsh-image-forge-settings-group-title { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: .005em; }
.dsh-settings-group-count { flex: none; padding: 2px 7px; border-radius: 999px; background: var(--dsh-settings-soft); color: var(--dsh-settings-muted); font-size: 10.5px; }
.dsh-image-forge-settings-group-hint { margin: -2px 0 2px; color: var(--dsh-settings-muted); font-size: 11.5px; line-height: 1.45; }
.dsh-image-forge-settings-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 14px;
}
.dsh-image-forge-setting {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
  padding: 11px 0;
  border-top: 1px solid color-mix(in srgb, currentColor 9%, transparent);
}
.dsh-image-forge-setting:nth-child(-n+2) { border-top: 0; padding-top: 4px; }
.dsh-settings-field-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.dsh-image-forge-setting-label { min-width: 0; padding-top: 1px; overflow: hidden; color: var(--dsh-settings-ink); font-size: 12px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dsh-settings-reset-button { flex: none; padding: 1px 0; border: 0; background: transparent; color: var(--dsh-settings-muted); font-size: 10px; cursor: pointer; opacity: .55; transition: opacity 120ms ease, color 120ms ease; }
.dsh-image-forge-setting:hover .dsh-settings-reset-button,
.dsh-image-forge-setting:focus-within .dsh-settings-reset-button,
.dsh-image-forge-setting.is-dirty .dsh-settings-reset-button { opacity: 1; }
.dsh-settings-reset-button:hover { color: var(--dsh-settings-accent); }
.dsh-image-forge-setting-control { min-width: 0; }
.dsh-settings-input-wrap { position: relative; display: flex; align-items: center; gap: 7px; min-width: 0; }
.dsh-settings-control {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 6px 9px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 1.5%, transparent);
  color: inherit;
  font-size: 12px;
  transition: border-color 120ms ease, background 120ms ease;
}
.dsh-settings-control:hover { border-color: color-mix(in srgb, currentColor 22%, transparent); }
.dsh-settings-control:focus { border-color: color-mix(in srgb, var(--dsh-settings-accent) 60%, var(--dsh-settings-line)); background: color-mix(in srgb, currentColor 2.5%, transparent); }
.dsh-settings-control:disabled { opacity: .55; }
.dsh-settings-input-wrap .dsh-settings-control { padding-right: 30px; }
.dsh-settings-unit { position: absolute; right: 9px; color: var(--dsh-settings-muted); font-size: 10.5px; pointer-events: none; }
.dsh-settings-reset-mark { position: absolute; right: 9px; padding: 1px 4px; border-radius: 4px; background: color-mix(in srgb, var(--dsh-settings-accent) 12%, transparent); color: var(--dsh-settings-accent); font-size: 9px; pointer-events: none; }
.dsh-settings-switch { display: inline-flex; align-items: center; gap: 8px; min-height: 34px; cursor: pointer; }
.dsh-settings-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.dsh-settings-switch-track { position: relative; display: inline-block; width: 34px; height: 19px; border-radius: 999px; background: color-mix(in srgb, currentColor 18%, transparent); transition: background 120ms ease; }
.dsh-settings-switch-thumb { position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px color-mix(in srgb, #000 20%, transparent); transition: transform 120ms ease; }
.dsh-settings-switch input:checked + .dsh-settings-switch-track { background: var(--dsh-settings-accent); }
.dsh-settings-switch input:checked + .dsh-settings-switch-track .dsh-settings-switch-thumb { transform: translateX(15px); }
.dsh-settings-switch input:focus-visible + .dsh-settings-switch-track { outline: 2px solid color-mix(in srgb, var(--dsh-settings-accent) 65%, transparent); outline-offset: 2px; }
.dsh-settings-switch-label { color: var(--dsh-settings-muted); font-size: 11.5px; }
.dsh-image-forge-setting-hint { margin: 0; color: var(--dsh-settings-muted); font-size: 10.5px; line-height: 1.45; overflow-wrap: anywhere; }
.dsh-image-forge-setting-status { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-height: 0; font-size: 10.5px; }
.dsh-image-forge-setting-status:empty { display: none; }
.dsh-settings-field-dirty { color: var(--dsh-settings-accent); }
.dsh-settings-field-reset { color: var(--dsh-settings-muted); }
.dsh-settings-field-error { color: color-mix(in srgb, #e03131 86%, currentColor); }
.dsh-image-forge-setting.is-dirty .dsh-settings-control { border-color: color-mix(in srgb, var(--dsh-settings-accent) 35%, var(--dsh-settings-line)); }
.dsh-image-forge-setting.is-invalid .dsh-settings-control { border-color: color-mix(in srgb, #e03131 58%, var(--dsh-settings-line)); }
.dsh-image-forge-setting.is-reset .dsh-settings-control { font-style: italic; }
.dsh-image-forge-advisory {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 13px;
  border: 1px solid color-mix(in srgb, #f08c00 30%, var(--dsh-settings-line));
  border-radius: 12px;
  background: color-mix(in srgb, #f08c00 7%, transparent);
}
.dsh-image-forge-advisory-title { margin: 0; font-size: 12px; font-weight: 650; }
.dsh-image-forge-advisory-p { margin: 0; color: var(--dsh-settings-muted); font-size: 11px; line-height: 1.5; }
.dsh-settings-savebar {
  position: sticky;
  z-index: 16;
  bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-top: 2px;
  padding: 11px 12px 11px 15px;
  border: 1px solid var(--dsh-settings-line);
  border-radius: 14px;
  background: color-mix(in srgb, Canvas 92%, transparent);
  box-shadow: 0 8px 28px color-mix(in srgb, #000 12%, transparent);
  backdrop-filter: blur(14px);
}
.dsh-settings-save-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 12px; }
.dsh-settings-save-copy strong { font-size: 12px; }
.dsh-settings-save-detail { overflow: hidden; color: var(--dsh-settings-muted); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.dsh-settings-save-detail.is-ok { color: color-mix(in srgb, #2f9e44 82%, currentColor); }
.dsh-settings-save-detail.is-error { color: color-mix(in srgb, #e03131 84%, currentColor); }
.dsh-settings-save-detail.is-info { color: var(--dsh-settings-muted); }
.dsh-settings-save-actions { display: flex; flex: none; gap: 7px; }
.dsh-settings-unavailable { display: flex; align-items: flex-start; gap: 12px; padding: 16px; border: 1px solid color-mix(in srgb, #f08c00 30%, var(--dsh-settings-line)); border-radius: 14px; background: color-mix(in srgb, #f08c00 7%, transparent); }
.dsh-settings-unavailable-mark { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 50%; background: color-mix(in srgb, #f08c00 16%, transparent); color: color-mix(in srgb, #f08c00 90%, currentColor); font-weight: 700; }
.dsh-settings-unavailable-copy h3 { margin: 0; font-size: 14px; }
.dsh-settings-unavailable-copy p { margin: 5px 0 0; color: var(--dsh-settings-muted); font-size: 12px; overflow-wrap: anywhere; }
.dsh-settings-skeleton { gap: 12px; }
.dsh-settings-skeleton-head,
.dsh-settings-skeleton-tabs,
.dsh-settings-skeleton-card { border-radius: 12px; background: linear-gradient(90deg, color-mix(in srgb, currentColor 4%, transparent), color-mix(in srgb, currentColor 8%, transparent), color-mix(in srgb, currentColor 4%, transparent)); background-size: 220% 100%; animation: dsh-settings-shimmer 1.4s ease-in-out infinite; }
.dsh-settings-skeleton-head { width: 46%; height: 58px; }
.dsh-settings-skeleton-tabs { width: 220px; height: 42px; }
.dsh-settings-skeleton-card { height: 180px; }
.dsh-settings-skeleton-card.is-tall { height: 290px; }
@keyframes dsh-settings-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
@keyframes dsh-settings-pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@container forge-settings (max-width: 760px) {
  .dsh-image-forge-settings-fields { grid-template-columns: minmax(0, 1fr); }
  .dsh-image-forge-setting:nth-child(2) { border-top: 1px solid color-mix(in srgb, currentColor 9%, transparent); padding-top: 11px; }
  .dsh-image-forge-setting:nth-child(1) { border-top: 0; padding-top: 4px; }
  .dsh-settings-environment-head,
  .dsh-settings-savebar { align-items: stretch; flex-direction: column; }
  .dsh-settings-environment-pills { justify-content: flex-start; }
  .dsh-settings-save-actions .dsh-settings-action { flex: 1 1 0; }
  .dsh-settings-log-head { align-items: flex-start; flex-direction: column; }
  .dsh-settings-log-actions { width: 100%; }
}
@container forge-settings (max-width: 520px) {
  .dsh-settings-heading { flex-direction: column; }
  .dsh-settings-heading-state { align-items: flex-start; flex-direction: row; }
  .dsh-settings-title { font-size: 18px; }
  .dsh-image-forge-tabs { width: 100%; }
  .dsh-image-forge-tab { flex: 1 0 92px; }
  .dsh-settings-environment { padding: 12px; }
  .dsh-settings-facts { grid-template-columns: minmax(58px, auto) minmax(0, 1fr); }
  .dsh-settings-log-source { max-width: 150px; }
  .dsh-settings-log-line { grid-template-columns: 38px minmax(0, 1fr); }
  .dsh-settings-log-time { display: none; }
  .dsh-settings-savebar { position: static; }
  .dsh-settings-save-detail { white-space: normal; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-image-forge-settings *,
  .dsh-image-forge-settings *::before,
  .dsh-image-forge-settings *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
`
