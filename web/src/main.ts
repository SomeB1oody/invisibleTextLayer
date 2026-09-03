/**
 * The page: drop a PDF file, type the text, save the result.
 *
 * The page does the work in the browser. The file does not leave the device.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import { InvisibleTextLayerError, addLayer } from './core.ts';

interface Loaded {
  name: string;
  bytes: Uint8Array;
  pageCount: number;
}

const dropZone = document.getElementById('drop') as HTMLButtonElement;
const dropLabel = document.getElementById('drop-label') as HTMLElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const textArea = document.getElementById('text') as HTMLTextAreaElement;
const runButton = document.getElementById('run') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLElement;

let loaded: Loaded | null = null;

function setStatus(text: string, tone: 'idle' | 'good' | 'bad' = 'idle'): void {
  status.textContent = text;
  status.dataset.tone = tone;
}

function updateButton(): void {
  runButton.disabled = loaded === null || textArea.value.trim() === '';
}

/** Read a PDF file and show its name and page count. */
async function load(file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    setStatus('That is not a PDF file. Drop a file with a .pdf name.', 'bad');
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const document = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    loaded = { name: file.name, bytes, pageCount: document.getPageCount() };
    dropZone.dataset.state = 'loaded';
    dropLabel.textContent = file.name;
    setStatus(`${loaded.pageCount} pages · ${(bytes.length / 1024).toFixed(0)} KB`);
  } catch {
    loaded = null;
    dropZone.dataset.state = 'empty';
    dropLabel.textContent = 'Drop a PDF here, or click to choose one';
    setStatus('That file did not open as a PDF.', 'bad');
  }
  updateButton();
}

/** Hand the finished file to the viewer. */
async function save(bytes: Uint8Array, filename: string): Promise<boolean> {
  const downloads = await window.claude?.use('downloads');
  if (downloads) {
    try {
      await downloads.save({ filename, data: bytes });
      return true;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'declined') return false;
      throw error;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

async function run(): Promise<void> {
  if (!loaded) return;
  const text = textArea.value.trim();
  runButton.disabled = true;
  setStatus('Writing the layer…');
  // Give the browser one frame to paint the new state before the work starts.
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const result = await addLayer(loaded.bytes, text);
    const stem = loaded.name.replace(/\.pdf$/i, '');
    const saved = await save(result.bytes, `${stem}.invisible.pdf`);
    const encoding = result.font === 'unicode' ? 'Identity-H' : 'WinAnsi';
    const lines = `${result.lineCount} line${result.lineCount === 1 ? '' : 's'}`;
    const detail =
      `mode 3 · ${encoding} · ${result.fontSize} pt · ` +
      `page ${result.pages.join(', ')} of ${loaded.pageCount} · ${lines}`;
    if (!saved) {
      setStatus(`Not saved. ${detail}`);
    } else if (result.verified) {
      setStatus(`Saved. ${detail}`, 'good');
    } else {
      setStatus(`Saved, but the check did not read the text back. ${detail}`, 'bad');
    }
  } catch (error) {
    const message =
      error instanceof InvisibleTextLayerError
        ? error.message
        : `the file could not be written (${(error as Error).message})`;
    setStatus(`Nothing was saved: ${message}`, 'bad');
  }
  updateButton();
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void load(file);
  fileInput.value = '';
});

for (const name of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    dropZone.dataset.drag = 'over';
  });
}
for (const name of ['dragleave', 'dragend', 'drop'] as const) {
  dropZone.addEventListener(name, () => delete dropZone.dataset.drag);
}
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file) void load(file);
});

textArea.addEventListener('input', updateButton);
runButton.addEventListener('click', () => void run());
updateButton();
