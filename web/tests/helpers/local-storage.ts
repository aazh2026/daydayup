/**
 * 测试用的 localStorage 替身。
 *
 * 前端测试跑在 Node 环境（无 DOM），但 `web/src/store/*.ts` 依赖
 * 浏览器 localStorage。这里提供一个行为一致最小实现：
 * - 键值对存储
 * - 序列化 / 反序列化（与浏览器一致，存的是字符串）
 * - 可配置为「抛异常」，用于验证容错分支
 */

export interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

class MemoryStorageImpl implements MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  key(index: number): string | null {
    const keys = [...this.map.keys()];
    return index >= 0 && index < keys.length ? keys[index] : null;
  }

  get length(): number {
    return this.map.size;
  }
}

/**
 * 安装 localStorage 替身到 globalThis。
 *
 * @param options.failOnWrite 设为 true 时，所有写操作抛错（模拟配额超限 / 隐私模式）
 * @returns 恢复函数
 */
export function installLocalStorage(
  options: { failOnWrite?: boolean } = {}
): { storage: MemoryStorage; restore: () => void } {
  const storage = new MemoryStorageImpl();
  const globalRef = globalThis as unknown as { localStorage?: MemoryStorage };

  const had = Object.prototype.hasOwnProperty.call(globalRef, 'localStorage');
  const previous = globalRef.localStorage;

  if (options.failOnWrite) {
    // 模拟「写入必然失败」——如 Safari 隐私模式或配额超限
    globalRef.localStorage = {
      getItem: (key) => storage.getItem(key),
      removeItem: (key) => storage.removeItem(key),
      clear: () => storage.clear(),
      key: (index) => storage.key(index),
      get length() {
        return storage.length;
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
  } else {
    globalRef.localStorage = storage;
  }

  return {
    storage,
    restore: () => {
      if (had) {
        globalRef.localStorage = previous;
      } else {
        delete globalRef.localStorage;
      }
    },
  };
}
