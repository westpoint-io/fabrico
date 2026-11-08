import { describe, expect, it } from 'vitest';
import {
  EMPTY_PROGRESS,
  PROGRESS_KEY,
  localStorageProgress,
  parseProgress,
  withLessonDone,
  withLessonStarted,
  type Progress,
} from './progress.ts';

const KNOWN = ['your-first-line'] as const;
const LESSON = 'your-first-line';

const stored = (value: unknown): string => JSON.stringify(value);

/** The part of `Storage` the store uses, backed by a plain object. */
function fakeStorage(initial: Record<string, string> = {}): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const noRemove = (): void => {};

describe('parseProgress', () => {
  it('reads a version 1 value holding only your-first-line the same once three lessons are known', () => {
    const blob = stored({ version: 1, lessons: { [LESSON]: 'done' } });
    const three = ['your-first-line', 'delete-and-undo', 'a-factory-with-two-outputs'] as const;
    expect(parseProgress(blob, three)).toEqual(parseProgress(blob, KNOWN));
    expect(parseProgress(blob, three).lessons).toEqual({ [LESSON]: 'done' });
  });

  it('reads a good value', () => {
    expect(parseProgress(stored({ version: 1, lessons: { [LESSON]: 'done' } }), KNOWN)).toEqual({
      version: 1,
      lessons: { [LESSON]: 'done' },
    });
  });

  it('reads nothing stored as empty', () => {
    expect(parseProgress(null, KNOWN)).toEqual(EMPTY_PROGRESS);
  });

  it('reads invalid JSON as empty', () => {
    expect(parseProgress('not json', KNOWN)).toEqual(EMPTY_PROGRESS);
  });

  it('reads a wrong version as empty', () => {
    expect(parseProgress(stored({ version: 2, lessons: { [LESSON]: 'done' } }), KNOWN)).toEqual(EMPTY_PROGRESS);
  });

  it('reads a value with no version as empty', () => {
    expect(parseProgress(stored({ lessons: { [LESSON]: 'done' } }), KNOWN)).toEqual(EMPTY_PROGRESS);
  });

  it('reads a top level that is not an object as empty', () => {
    expect(parseProgress(stored(['done']), KNOWN)).toEqual(EMPTY_PROGRESS);
    expect(parseProgress(stored(null), KNOWN)).toEqual(EMPTY_PROGRESS);
    expect(parseProgress(stored(7), KNOWN)).toEqual(EMPTY_PROGRESS);
  });

  it('reads a lessons field that is not an object as empty', () => {
    expect(parseProgress(stored({ version: 1, lessons: 'done' }), KNOWN)).toEqual(EMPTY_PROGRESS);
    expect(parseProgress(stored({ version: 1, lessons: null }), KNOWN)).toEqual(EMPTY_PROGRESS);
    expect(parseProgress(stored({ version: 1, lessons: [LESSON] }), KNOWN)).toEqual(EMPTY_PROGRESS);
  });

  it('reads an unknown status as empty', () => {
    expect(parseProgress(stored({ version: 1, lessons: { [LESSON]: 'finished' } }), KNOWN)).toEqual(EMPTY_PROGRESS);
  });

  it('drops an unknown lesson id and keeps the known ones', () => {
    expect(parseProgress(stored({ version: 1, lessons: { gone: 'done', [LESSON]: 'inProgress' } }), KNOWN)).toEqual({
      version: 1,
      lessons: { [LESSON]: 'inProgress' },
    });
  });

  it('ignores a __proto__ key in the stored text', () => {
    const parsed = parseProgress(`{"version":1,"lessons":{"__proto__":"done","${LESSON}":"done"}}`, KNOWN);
    expect(Object.keys(parsed.lessons)).toEqual([LESSON]);
    expect(Object.getPrototypeOf(parsed.lessons)).toBe(Object.prototype);
  });
});

describe('localStorageProgress', () => {
  it('reads back what it wrote, under the one key', () => {
    const storage = fakeStorage();
    const store = localStorageProgress(storage, KNOWN);
    const written: Progress = { version: 1, lessons: { [LESSON]: 'done' } };
    store.write(written);
    expect(Object.keys(storage.data)).toEqual([PROGRESS_KEY]);
    expect(PROGRESS_KEY).toBe('fab.tutorial.v1');
    expect(store.read()).toEqual(written);
  });

  it('reads a corrupt stored value as empty', () => {
    const store = localStorageProgress(fakeStorage({ [PROGRESS_KEY]: 'not json' }), KNOWN);
    expect(store.read()).toEqual(EMPTY_PROGRESS);
  });

  it('reads empty when getItem throws', () => {
    const store = localStorageProgress(
      {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {},
        removeItem: noRemove,
      },
      KNOWN,
    );
    expect(store.read()).toEqual(EMPTY_PROGRESS);
  });

  it("doesn't throw when setItem throws", () => {
    const store = localStorageProgress(
      {
        getItem: () => null,
        setItem: () => {
          throw new Error('full');
        },
        removeItem: noRemove,
      },
      KNOWN,
    );
    expect(() => store.write({ version: 1, lessons: { [LESSON]: 'done' } })).not.toThrow();
  });

  describe('when storage fails', () => {
    const DONE: Progress = { version: 1, lessons: { [LESSON]: 'done' } };
    const blocked = (): never => {
      throw new Error('blocked');
    };

    it('reads back a write that could not be stored', () => {
      const store = localStorageProgress({ getItem: () => null, setItem: blocked, removeItem: noRemove }, KNOWN);
      store.write(DONE);
      expect(store.read()).toEqual(DONE);
    });

    it('reads back a write when reading throws too', () => {
      const store = localStorageProgress({ getItem: blocked, setItem: blocked, removeItem: noRemove }, KNOWN);
      store.write(DONE);
      expect(store.read()).toEqual(DONE);
    });

    it('reads back a write that was stored, when a later read throws', () => {
      let reads = 0;
      const store = localStorageProgress(
        {
          getItem: () => {
            reads += 1;
            throw new Error('blocked');
          },
          setItem: () => {},
          removeItem: noRemove,
        },
        KNOWN,
      );
      store.write(DONE);
      expect(store.read()).toEqual(DONE);
      expect(reads, 'it did try storage first').toBe(1);
    });

    it('reads back a write with no storage at all', () => {
      const store = localStorageProgress(null, KNOWN);
      store.write(DONE);
      expect(store.read()).toEqual(DONE);
    });

    it('goes back to storage once a write gets through', () => {
      const storage = fakeStorage();
      let full = true;
      const store = localStorageProgress(
        {
          getItem: storage.getItem,
          setItem: (k, v) => {
            if (full) throw new Error('full');
            storage.setItem(k, v);
          },
          removeItem: storage.removeItem,
        },
        KNOWN,
      );
      store.write(DONE);
      full = false;
      const later: Progress = { version: 1, lessons: { [LESSON]: 'inProgress' } };
      store.write(later);
      expect(storage.data[PROGRESS_KEY], 'the later write reached storage').toBe(JSON.stringify(later));
      storage.setItem(PROGRESS_KEY, JSON.stringify(DONE));
      expect(store.read(), 'and reads come from storage again').toEqual(DONE);
    });
  });

  describe('clear', () => {
    const DONE: Progress = { version: 1, lessons: { [LESSON]: 'done' } };
    const blocked = (): never => {
      throw new Error('blocked');
    };

    it('removes the one key, and the next read is empty', () => {
      const storage = fakeStorage({ [PROGRESS_KEY]: JSON.stringify(DONE), other: 'kept' });
      const store = localStorageProgress(storage, KNOWN);
      expect(store.read()).toEqual(DONE);
      store.clear();
      expect(store.read()).toEqual(EMPTY_PROGRESS);
      expect(Object.keys(storage.data), 'only the progress key went').toEqual(['other']);
    });

    it('forgets the last write too, when reading throws', () => {
      // Without this the cached write would bring Done back on the next read.
      const store = localStorageProgress({ getItem: blocked, setItem: () => {}, removeItem: () => {} }, KNOWN);
      store.write(DONE);
      expect(store.read(), 'the cached write reads back first').toEqual(DONE);
      store.clear();
      expect(store.read()).toEqual(EMPTY_PROGRESS);
    });

    it("doesn't throw when removeItem throws, and the next read is still empty", () => {
      const storage = fakeStorage({ [PROGRESS_KEY]: JSON.stringify(DONE) });
      const store = localStorageProgress({ getItem: storage.getItem, setItem: storage.setItem, removeItem: blocked }, KNOWN);
      expect(() => store.clear()).not.toThrow();
      expect(store.read(), 'the old value is still stored, and it must not read back this run').toEqual(EMPTY_PROGRESS);
    });

    it('goes back to storage once a later write gets through', () => {
      const storage = fakeStorage({ [PROGRESS_KEY]: JSON.stringify(DONE) });
      const store = localStorageProgress({ getItem: storage.getItem, setItem: storage.setItem, removeItem: blocked }, KNOWN);
      store.clear();
      const later: Progress = { version: 1, lessons: { [LESSON]: 'inProgress' } };
      store.write(later);
      expect(store.read()).toEqual(later);
      expect(storage.data[PROGRESS_KEY]).toBe(JSON.stringify(later));
    });

    it('works with no storage at all', () => {
      const store = localStorageProgress(null, KNOWN);
      store.write(DONE);
      store.clear();
      expect(store.read()).toEqual(EMPTY_PROGRESS);
    });
  });

  it('works with no storage at all', () => {
    const store = localStorageProgress(null, KNOWN);
    expect(store.read()).toEqual(EMPTY_PROGRESS);
    expect(() => store.write(EMPTY_PROGRESS)).not.toThrow();
  });
});

describe('the marks a lesson leaves', () => {
  it('a started lesson reads in progress', () => {
    expect(withLessonStarted(EMPTY_PROGRESS, LESSON).lessons[LESSON]).toBe('inProgress');
  });

  it('a finished lesson reads done', () => {
    expect(withLessonDone(withLessonStarted(EMPTY_PROGRESS, LESSON), LESSON).lessons[LESSON]).toBe('done');
  });

  it('done sticks when a finished lesson starts again', () => {
    expect(withLessonStarted(withLessonDone(EMPTY_PROGRESS, LESSON), LESSON).lessons[LESSON]).toBe('done');
  });

  it("leaves the shared empty value alone", () => {
    withLessonStarted(EMPTY_PROGRESS, LESSON);
    expect(EMPTY_PROGRESS.lessons).toEqual({});
  });
});
