import { inpaintPhotoPatchBased } from './photoInpaint';

export interface InpaintWorkerRequest {
  srcBuffer: ArrayBuffer;
  maskBuffer: ArrayBuffer;
  width: number;
  height: number;
  dilatePx: number;
  featherPx: number;
  addGrain: boolean;
}

export type InpaintWorkerMessage =
  | { type: 'progress'; percent: number; stage: string }
  | { type: 'done'; rgbaBuffer: ArrayBuffer; engineUsed: 'patchmatch' | 'telea-fallback' }
  | { type: 'error'; message: string };

self.onmessage = (event: MessageEvent<InpaintWorkerRequest>) => {
  try {
    const { srcBuffer, maskBuffer, width, height, dilatePx, featherPx, addGrain } = event.data;
    const srcRgba = new Uint8ClampedArray(srcBuffer);
    const mask = new Uint8Array(maskBuffer);

    const result = inpaintPhotoPatchBased({
      srcRgba,
      mask,
      width,
      height,
      dilatePx,
      featherPx,
      addGrain,
      onProgress: (percent, stage) => {
        const msg: InpaintWorkerMessage = { type: 'progress', percent, stage };
        self.postMessage(msg);
      },
    });

    const outCopy = new Uint8ClampedArray(result.rgba);
    const doneMsg: InpaintWorkerMessage = {
      type: 'done',
      rgbaBuffer: outCopy.buffer,
      engineUsed: result.engineUsed,
    };
    self.postMessage(doneMsg, { transfer: [outCopy.buffer] });
  } catch (err) {
    const errMsg: InpaintWorkerMessage = {
      type: 'error',
      message: err instanceof Error ? err.message : 'Worker inpainting failed.',
    };
    self.postMessage(errMsg);
  }
};
