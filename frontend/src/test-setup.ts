import '@testing-library/jest-dom';

// Node.js's built-in localStorage (from --localstorage-file) shadows jsdom's 
// implementation and only supports property access (localStorage['key'] = 'value'),
// not the Web Storage API (localStorage.setItem/getItem/removeItem/clear).
// We replace it with a proper Web Storage API-compatible implementation.

class MockStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    const keys = [...this.store.keys()];
    return keys[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  // Allow index signature for property access
  [key: string]: unknown;
}

// Replace globalThis.localStorage with our proper implementation
const mockStorage = new MockStorage();
Object.defineProperty(globalThis, 'localStorage', {
  value: mockStorage,
  writable: true,
  configurable: true,
});

// Also ensure window.localStorage points to the same instance
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: mockStorage,
    writable: true,
    configurable: true,
  });
}

// Reset storage before each test
beforeEach(() => {
  mockStorage.clear();
});
