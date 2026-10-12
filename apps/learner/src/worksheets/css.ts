/**
 * The print stylesheet: A4 portrait, black on white, no backgrounds a printer would waste ink on. Page breaks are
 * kept off the middle of a question and off the line after a heading. On a screen (the preview in the app) the sheet
 * is shown as a page that narrows to fit a phone.
 */
export const WORKSHEET_CSS = `
@page { size: A4 portrait; margin: 14mm 14mm 16mm 14mm; @bottom-center { content: "CUSTAR Tutor · page " counter(page) " of " counter(pages); font: 9pt Arial, Helvetica, sans-serif; color: #000; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; background: #fff; color: #000; font: 12pt/1.45 "Noto Sans", Arial, Helvetica, sans-serif; }
.sheet { background: #fff; color: #000; }
h1, h2, h3, p { margin: 0; }
strong { font-weight: 700; }

.head { border-bottom: 2.5pt solid #000; padding-bottom: 3mm; margin-bottom: 4mm; }
.brand { font-size: 10pt; font-weight: 700; letter-spacing: 0.35em; }
.meta { font-size: 10pt; margin-top: 1mm; }
.head h1 { font-size: 20pt; line-height: 1.2; margin-top: 2mm; }
.kind { display: inline-block; margin-top: 2.5mm; border: 1.5pt solid #000; padding: 0.6mm 3mm; font-size: 10pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }

.name-line { display: flex; gap: 8mm; margin: 0 0 4mm; font-size: 12pt; }
.name-line .field { display: flex; align-items: flex-end; gap: 2mm; }
.name-line .field.name { flex: 2; }
.name-line .field.date { flex: 1; }
.name-line .fill { flex: 1; min-height: 7mm; border-bottom: 1pt solid #000; padding: 0 2mm 0.5mm; font-weight: 700; }

.objective { border: 1.5pt solid #000; border-left-width: 5pt; padding: 2.5mm 4mm; margin-bottom: 4mm; }
.intro { margin-bottom: 4mm; }
.note { font-size: 10.5pt; margin-bottom: 2.5mm; }

h2 { font-size: 14pt; margin: 4mm 0 2.5mm; padding-bottom: 1mm; border-bottom: 1pt solid #000; break-after: avoid; page-break-after: avoid; }
.section { margin-bottom: 4mm; }

.q { margin: 0 0 4mm; break-inside: avoid; page-break-inside: avoid; }
.qhead { display: flex; gap: 3mm; align-items: baseline; }
.qnum { font-weight: 700; min-width: 7mm; }
.qprompt { flex: 1; font-weight: 600; }
.q.unnumbered .qbody { margin-left: 0; }
.qbody { margin: 2mm 0 0 10mm; }
.qhelp { font-size: 10pt; font-style: italic; margin-bottom: 1.5mm; }

.box { display: inline-block; width: 5mm; height: 5mm; border: 1.2pt solid #000; vertical-align: -1mm; flex: none; }
.box.write { width: 12mm; height: 8mm; vertical-align: middle; }
.opt { display: flex; gap: 3mm; align-items: baseline; margin: 0 0 2mm; }
.opt .letter { font-weight: 700; min-width: 5mm; }
.blank { display: inline-block; min-width: 38mm; border-bottom: 1pt solid #000; height: 1.1em; vertical-align: baseline; margin: 0 0.5mm; }

.circles { display: flex; flex-wrap: wrap; gap: 3mm 4mm; }
.circle-opt { border: 1.2pt solid #000; border-radius: 999px; padding: 1.2mm 5mm; }

.match { display: flex; gap: 14mm; }
.match .col { flex: 1; }
.match .row { display: flex; align-items: center; gap: 3mm; margin: 0 0 2mm; min-height: 8mm; }
.match .num, .match .letter { font-weight: 700; min-width: 6mm; }

.wordbox { border: 1.2pt dashed #000; padding: 2mm 4mm; margin-bottom: 3mm; }
table.sort { width: 100%; border-collapse: collapse; }
table.sort th, table.sort td { border: 1.2pt solid #000; padding: 1.5mm 3mm; text-align: left; }
table.sort td { height: 9mm; }

.picture { border: 1.5pt solid #000; padding: 4mm; min-height: 32mm; display: flex; flex-direction: column; justify-content: center; gap: 1mm; margin-bottom: 3mm; }
.picture .label { font-size: 9pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.picture .what { font-style: italic; }

.draw-box { border: 1.5pt solid #000; height: 40mm; margin-bottom: 2mm; }
.lines .line { border-bottom: 1pt solid #000; height: 8mm; }
.say { display: flex; gap: 3mm; align-items: center; }

.drill, .take-home { break-inside: avoid; page-break-inside: avoid; }
.drill-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 6mm; }
.cell { border: 1.2pt solid #000; padding: 2mm 3mm; min-height: 17mm; break-inside: avoid; page-break-inside: avoid; }
.cell .n { font-weight: 700; margin-right: 2mm; }
.cell .opt { margin: 1mm 0 0; }
.cell .lines .line { height: 7mm; }
.take-home .tip { border: 1.5pt solid #000; border-left-width: 5pt; padding: 3mm 4mm; margin-bottom: 4mm; }

.answers .a { margin: 0 0 3mm; break-inside: avoid; page-break-inside: avoid; display: flex; gap: 3mm; }
.answers .a .qnum { min-width: 9mm; }
.answers .a .atext { flex: 1; }
.answers .why { font-size: 10pt; margin-top: 0.5mm; }
.answers ul { margin: 0.5mm 0 0 5mm; padding: 0; }
.callout { border: 1.5pt solid #000; padding: 3mm 4mm; margin-bottom: 4mm; break-inside: avoid; page-break-inside: avoid; }
.page-break { height: 0; break-after: page; page-break-after: always; }

@media screen {
  body { background: #e7ecea; padding: 10px; }
  .sheet { max-width: 210mm; margin: 0 auto; padding: 12mm; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25); }
  .page-break { border-top: 1px dashed #888; margin: 8mm 0; height: 0; }
}
@media screen and (max-width: 600px) {
  body { padding: 0; font-size: 11pt; }
  .sheet { padding: 12px; box-shadow: none; }
  .head h1 { font-size: 16pt; }
  .qbody { margin-left: 0; }
  .drill-grid { grid-template-columns: 1fr; }
  .match { gap: 6mm; }
  .name-line { flex-direction: column; gap: 3mm; }
}
@media print {
  .sheet { max-width: none; padding: 0; box-shadow: none; }
  .page-break { border: 0; margin: 0; }
}
`;
