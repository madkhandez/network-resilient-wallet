const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** Check if the browser reports online status. Not authoritative — network may still fail. */
export function isOnline(): boolean {
  return navigator.onLine;
}

async function fetchWithTimeout(resource: RequestInfo, options: RequestInit & { timeout?: number } = {}) {
  const { timeout = 15000 } = options;
  
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal  
    });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    if (err instanceof DOMException && err.name === 'AbortError') {
      // Client timeout — does NOT mean the server rolled back.
      // The transfer may have committed. This is an ambiguous failure.
      throw new NetworkError('Request timed out — the server may still be processing');
    }
    // TypeError from fetch = network failure (offline, DNS, connection refused, etc.)
    throw new NetworkError('Network error — check your connection');
  }
}

export async function apiFetch(endpoint: string, options: RequestInit = {}) {
  const token = localStorage.getItem('jwt');
  const headers = new Headers(options.headers || {});
  
  headers.set('Content-Type', 'application/json');
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetchWithTimeout(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401) {
      // Auth failure — clear token but do NOT clear pending queue
      localStorage.removeItem('jwt');
    }
    
    let message = 'An error occurred';
    try {
      const errData = await response.json();
      message = errData.error || message;
    } catch {
      // Response body not JSON — use default message
    }
    
    throw new ApiError(response.status, message);
  }

  // Handle 204 No Content or empty responses
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

