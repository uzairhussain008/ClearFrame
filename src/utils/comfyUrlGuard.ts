export interface ComfyUrlValidationResult {
  valid: boolean;
  origin?: string;
  hostname?: string;
  error?: string;
}

export interface ComfyGpuStats {
  hasGpu: boolean;
  gpuName?: string;
  vramGb?: number;
  comfyVersion?: string;
}

export interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function parseIpv4Octets(ip: string): number[] | null {
  const match = ip.match(IPV4_REGEX);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

export function isPublicIpAddress(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (!normalized) return false;

  // Reject IPv4-mapped IPv6 addresses unless the embedded IPv4 is public
  if (normalized.startsWith('::ffff:')) {
    const v4Part = normalized.slice(7);
    const v4FromMapped = parseIpv4Octets(v4Part);
    if (v4FromMapped) {
      return isPublicIpAddress(v4Part);
    }
    return false;
  }

  const v4 = parseIpv4Octets(normalized);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return false; // 0.0.0.0/8 current network
    if (a === 10) return false; // 10.0.0.0/8 RFC1918
    if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGNAT
    if (a === 127) return false; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12 RFC1918
    if (a === 192 && b === 168) return false; // 192.168.0.0/16 RFC1918
    if (a === 192 && b === 0 && v4[2] === 0) return false; // 192.0.0.0/24
    if (a === 192 && b === 0 && v4[2] === 2) return false; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // Benchmarking
    if (a >= 224) return false; // Multicast & reserved
    return true;
  }

  // IPv6 checks
  if (normalized.includes(':')) {
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('fe80:') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return false; // Link-local fe80::/10
    }
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return false; // Unique local fc00::/7
    }
    if (normalized.startsWith('ff')) {
      return false; // Multicast ff00::/8
    }
    return /^[0-9a-f:]+$/.test(normalized);
  }

  return false;
}

export function validateComfyUrlFormat(rawUrl: string): ComfyUrlValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'Paste your Colab HTTPS tunnel URL first.' };
  }

  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { valid: false, error: 'Paste your Colab HTTPS tunnel URL first.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Enter a valid HTTPS URL (e.g. https://example.trycloudflare.com).' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only HTTPS URLs are allowed for AI GPU connections.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with embedded credentials are not allowed.' };
  }

  if (parsed.port && parsed.port !== '443') {
    return { valid: false, error: 'Custom ports are not allowed; use the standard HTTPS tunnel URL.' };
  }

  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    return { valid: false, error: 'Paste the base tunnel URL only (without extra paths or query parameters).' };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || !hostname.includes('.')) {
    return { valid: false, error: 'Invalid tunnel hostname.' };
  }

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.arpa') ||
    hostname.endsWith('.home')
  ) {
    return { valid: false, error: 'Local or internal hostnames are not allowed.' };
  }

  // Reject bare IPv4 or bracketed IPv6 literals directly
  if (hostname.startsWith('[') || parseIpv4Octets(hostname)) {
    return { valid: false, error: 'Direct IP addresses are not allowed; use your HTTPS tunnel domain.' };
  }

  if (!/^[a-z0-9.-]+$/.test(hostname)) {
    return { valid: false, error: 'Hostname contains unsupported characters.' };
  }

  return {
    valid: true,
    origin: `https://${hostname}`,
    hostname,
  };
}

export function extractGpuStats(payload: unknown): ComfyGpuStats {
  if (!payload || typeof payload !== 'object') {
    return { hasGpu: false };
  }
  const obj = payload as {
    system?: { comfyui_version?: unknown };
    devices?: Array<{
      name?: unknown;
      type?: unknown;
      vram_total?: unknown;
    }>;
  };

  const comfyVersion =
    typeof obj.system?.comfyui_version === 'string' ? obj.system.comfyui_version : undefined;

  const devices = Array.isArray(obj.devices) ? obj.devices : [];
  for (const dev of devices) {
    if (!dev || typeof dev !== 'object') continue;
    const type = typeof dev.type === 'string' ? dev.type.toLowerCase() : '';
    const name = typeof dev.name === 'string' ? dev.name : '';

    if (type === 'cpu') continue;
    const looksLikeGpu =
      type === 'cuda' ||
      type === 'mps' ||
      /cuda|nvidia|tesla|rtx|gtx|t4|l4|a100|v100|gpu/i.test(`${type} ${name}`);

    if (looksLikeGpu) {
      const vramBytes = typeof dev.vram_total === 'number' && Number.isFinite(dev.vram_total) ? dev.vram_total : 0;
      const vramGb = vramBytes > 0 ? Math.round((vramBytes / (1024 * 1024 * 1024)) * 10) / 10 : undefined;
      const cleanName = name.replace(/^cuda:\d+\s*/i, '').trim() || 'NVIDIA GPU';
      return {
        hasGpu: true,
        gpuName: cleanName,
        vramGb,
        comfyVersion,
      };
    }
  }

  return { hasGpu: false, comfyVersion };
}

export interface ComfyWorkflowParams {
  inputFilename: string;
  modelName: string;
  targetWidth: number;
  targetHeight: number;
  frameRate: number;
  filenamePrefix: string;
  framesPerBatch?: number;
}

export function buildComfyUpscaleWorkflow(params: ComfyWorkflowParams): Record<string, unknown> {
  const safeFps = Number.isFinite(params.frameRate) && params.frameRate > 0 ? params.frameRate : 30;
  const framesPerBatch = Math.max(4, Math.min(32, Math.round(params.framesPerBatch ?? 16)));

  return {
    '1': {
      class_type: 'VHS_BatchManager',
      inputs: {
        frames_per_batch: framesPerBatch,
      },
    },
    '2': {
      class_type: 'UpscaleModelLoader',
      inputs: {
        model_name: params.modelName,
      },
    },
    '3': {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: params.inputFilename,
        force_rate: 0,
        custom_width: 0,
        custom_height: 0,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
        meta_batch: ['1', 0],
      },
    },
    '4': {
      class_type: 'ImageUpscaleWithModel',
      inputs: {
        upscale_model: ['2', 0],
        image: ['3', 0],
      },
    },
    '5': {
      class_type: 'ImageScale',
      inputs: {
        image: ['4', 0],
        upscale_method: 'lanczos',
        width: Math.max(2, Math.round(params.targetWidth)),
        height: Math.max(2, Math.round(params.targetHeight)),
        crop: 'disabled',
      },
    },
    '6': {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: ['5', 0],
        frame_rate: safeFps,
        loop_count: 0,
        filename_prefix: params.filenamePrefix,
        format: 'video/h264-mp4',
        pingpong: false,
        save_output: true,
        pix_fmt: 'yuv420p',
        crf: 16,
        save_metadata: false,
        trim_to_audio: false,
        meta_batch: ['1', 0],
      },
    },
  };
}

export function parseComfyOutputFromHistory(
  historyEntry: unknown,
  filenamePrefix?: string
): ComfyOutputFile | null {
  if (!historyEntry || typeof historyEntry !== 'object') return null;
  const outputs = (historyEntry as { outputs?: Record<string, unknown> }).outputs;
  if (!outputs || typeof outputs !== 'object') return null;

  for (const nodeOutput of Object.values(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue;
    const record = nodeOutput as {
      unfinished_batch?: unknown;
      gifs?: Array<Record<string, unknown>>;
      videos?: Array<Record<string, unknown>>;
    };

    if (Array.isArray(record.unfinished_batch) && record.unfinished_batch[0] === true) {
      continue;
    }

    const candidates = [
      ...(Array.isArray(record.gifs) ? record.gifs : []),
      ...(Array.isArray(record.videos) ? record.videos : []),
    ];

    for (const item of candidates) {
      const filename = typeof item?.filename === 'string' ? item.filename : '';
      if (!filename) continue;
      if (filenamePrefix && !filename.startsWith(filenamePrefix)) continue;
      return {
        filename,
        subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
        type: typeof item.type === 'string' ? item.type : 'output',
      };
    }
  }

  return null;
}
