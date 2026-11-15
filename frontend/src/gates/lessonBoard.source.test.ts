// lessonBoard.source.test.ts - holds a lesson's prepared board together across the three languages it
// crosses: the lesson data (TypeScript), the board file (RON) and the host's id list and Tauri command
// (Rust). A drift in any one of them leaves the lesson on its loading card forever, with every test on
// either side still green, because no single side can see the other.
//
// It reads the board file, demo_scene.rs, lib.rs and tauriChannel.ts as text. One direction only: the
// frontend reads the Rust and the RON, and nothing on the Rust side reads the frontend.
//
// 1. Each machine a lesson declares names a Place line in the board file, by the node key the reducer
//    computes (kind and the footprint's top left cell), and every Place line is declared. A footprint is
//    anchored at its top left cell whatever its rotation, so a Rotate never moves the key.
// 2. The lesson board id type, the lesson's board id and the one string LessonBoard::parse accepts are
//    the same string, and demo_scene.rs embeds the board file this gate reads.
// 3. The key tauriChannel.ts passes to the load_lesson_board invoke is the camelCase form of the
//    command's parameter in lib.rs, the mapping Tauri makes.
// 4. The ring cell the lesson declares is the cell past the last cell of the board file's DrawBelt, one
//    more step in the direction of its last two cells: the cell the app rings past the stub's free end,
//    which the join step grades.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BELTS_THAT_JOIN } from '../tutorial/lessons/beltsThatJoin.ts';
import type { Lesson } from '../tutorial/types.ts';

const REPO = new URL('../../../', import.meta.url);
const BOARD_FILE = 'examples/boards/lessons/belts-that-join.board.ron';
const DEMO_SCENE = 'crates/fabrico-host/src/demo_scene.rs';
const APP_LIB = 'crates/fabrico-app/src/lib.rs';
const TAURI_CHANNEL = 'frontend/src/transport/tauriChannel.ts';
const TYPES = 'frontend/src/tutorial/types.ts';

const read = (path: string): string => readFileSync(new URL(path, REPO), 'utf8');

/** The text with every `//` comment taken off its line. None of these files puts `//` inside a string. */
function withoutLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** The node key of each Place command in a board file, `<kind>@<x>,<y>`, in command order. */
function placeKeys(ron: string): string[] {
  const keys: string[] = [];
  for (const m of withoutLineComments(ron).matchAll(/Place\(\s*kind:\s*(\d+)\s*,\s*cell_x:\s*(\d+)\s*,\s*cell_y:\s*(\d+)\s*\)/g)) {
    keys.push(`${m[1]}@${m[2]},${m[3]}`);
  }
  return keys;
}

/** The cells of the last `DrawBelt(cells: [...])` command in a board file, in order. Empty with none. */
function drawBeltCells(ron: string): Array<{ x: number; y: number }> {
  const lists = [...withoutLineComments(ron).matchAll(/DrawBelt\(\s*cells:\s*\[([^\]]*)\]\s*\)/g)];
  const last = lists[lists.length - 1];
  if (last === undefined) return [];
  return [...(last[1] as string).matchAll(/\(\s*(\d+)\s*,\s*(\d+)\s*\)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
}

/** Pin 4: the lesson's declared ring cell against the cell past the board file's stub. Empty means they agree. */
function ringFindings(lesson: Lesson, ron: string, file: string): string[] {
  const ring = lesson.board?.ring;
  if (ring === undefined) return [`lesson ${lesson.id} declares no ring cell, so there is nothing to hold to ${file}`];
  const cells = drawBeltCells(ron);
  const end = cells[cells.length - 1];
  const before = cells[cells.length - 2];
  if (end === undefined || before === undefined) return [`${file}: ${cells.length} DrawBelt cells read, and the ring needs the last two`];
  const past = { x: end.x + (end.x - before.x), y: end.y + (end.y - before.y) };
  if (past.x === ring.x && past.y === ring.y) return [];
  return [
    `lesson ${lesson.id} declares its ring cell as (${ring.x},${ring.y}), and the cell past the DrawBelt in ${file}, stepping on from (${before.x},${before.y}) and (${end.x},${end.y}), is (${past.x},${past.y})`,
  ];
}

/** Pin 1: the lesson's declared machines against the board file's Place lines. Empty means they agree. */
function declaredKeyFindings(lesson: Lesson, ron: string, file: string): string[] {
  const out: string[] = [];
  if (lesson.board === undefined) return [`lesson ${lesson.id} declares no board, so there is nothing to hold to ${file}`];
  const placed = placeKeys(ron);
  if (placed.length === 0) out.push(`${file}: no Place line read, so the gate read nothing`);
  const declared = lesson.board.machines.map((m) => m.nodeKey);
  for (const { nodeKey, bind } of lesson.board.machines) {
    if (!placed.includes(nodeKey)) {
      out.push(`lesson ${lesson.id} declares its ${bind} as ${nodeKey}, and no Place line in ${file} puts that kind's top left cell there (Place lines: ${placed.join(', ')})`);
    }
  }
  for (const key of placed) {
    if (!declared.includes(key)) {
      out.push(`${file} places ${key}, and lesson ${lesson.id} doesn't declare it, so its start never matches the board`);
    }
  }
  return out;
}

/** The literal of `export type LessonBoardId = '...';`, or null with none or more than one. */
function lessonBoardIdLiteral(typesSource: string): string | null {
  const m = /export type LessonBoardId\s*=\s*'([^']+)'\s*;/.exec(typesSource);
  return m === null ? null : (m[1] as string);
}

/** The strings the body of `LessonBoard::parse` in demo_scene.rs maps to a board. */
function parseArms(demoScene: string): string[] {
  const src = withoutLineComments(demoScene);
  const impl = src.indexOf('impl LessonBoard {');
  if (impl < 0) return [];
  const fnAt = src.indexOf('pub fn parse(', impl);
  if (fnAt < 0) return [];
  const bodyEnd = src.indexOf('\n    }\n', fnAt);
  const body = src.slice(fnAt, bodyEnd < 0 ? undefined : bodyEnd);
  return [...body.matchAll(/"([^"]+)"\s*=>\s*Some\(/g)].map((m) => m[1] as string);
}

/** Pin 2: the id type, the lesson's id and the host's parse agree, and the host embeds this board file. */
function boardIdFindings(lesson: Lesson, typesSource: string, demoScene: string, file: string): string[] {
  const out: string[] = [];
  const literal = lessonBoardIdLiteral(typesSource);
  const arms = parseArms(demoScene);
  if (literal === null) out.push(`${TYPES}: no single-string LessonBoardId type read`);
  if (arms.length !== 1) out.push(`${DEMO_SCENE}: LessonBoard::parse accepts ${arms.length} ids (${arms.join(', ')}), and this gate holds exactly one`);
  const accepted = arms[0];
  if (literal !== null && accepted !== undefined && literal !== accepted) {
    out.push(`${TYPES} types the lesson board id as '${literal}', and LessonBoard::parse in ${DEMO_SCENE} accepts "${accepted}"`);
  }
  const id = lesson.board?.id;
  if (accepted !== undefined && id !== accepted) {
    out.push(`lesson ${lesson.id} asks for board '${String(id)}', and LessonBoard::parse in ${DEMO_SCENE} accepts "${accepted}"`);
  }
  if (!withoutLineComments(demoScene).includes(`include_str!("../../../${file}")`)) {
    out.push(`${DEMO_SCENE} doesn't embed ${file}, so the board the host loads isn't the one this gate reads`);
  }
  return out;
}

/** `boardId` to `board_id`: the case mapping Tauri makes from an invoke key to a command parameter. */
function snakeOf(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Pin 3: the invoke key in tauriChannel.ts against the command's parameter in lib.rs. */
function invokeKeyFindings(channel: string, appLib: string): string[] {
  const out: string[] = [];
  const keys = [...withoutLineComments(channel).matchAll(/invoke\(\s*'load_lesson_board'\s*,\s*\{\s*(\w+)\s*:/g)].map((m) => m[1] as string);
  const params = [...withoutLineComments(appLib).matchAll(/fn load_lesson_board\(\s*(\w+)\s*:\s*String/g)].map((m) => m[1] as string);
  if (keys.length !== 1) out.push(`${TAURI_CHANNEL}: ${keys.length} load_lesson_board invokes with an argument object read, and this gate holds exactly one`);
  if (params.length !== 1) out.push(`${APP_LIB}: ${params.length} load_lesson_board commands taking a String read, and this gate holds exactly one`);
  const key = keys[0];
  const param = params[0];
  if (key !== undefined && param !== undefined && snakeOf(key) !== param) {
    out.push(`${TAURI_CHANNEL} invokes load_lesson_board with the key ${key}, which Tauri maps to ${snakeOf(key)}, and the command's parameter in ${APP_LIB} is ${param}`);
  }
  return out;
}

const REAL = {
  ron: read(BOARD_FILE),
  demoScene: read(DEMO_SCENE),
  appLib: read(APP_LIB),
  channel: read(TAURI_CHANNEL),
  types: read(TYPES),
};

describe("a lesson's prepared board, held across TypeScript, RON and Rust", () => {
  it('reads the real files', () => {
    expect(placeKeys(REAL.ron)).toEqual(['0@1,2', '7@6,6']);
    expect(drawBeltCells(REAL.ron)).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
      { x: 4, y: 2 },
      { x: 5, y: 2 },
    ]);
    expect(parseArms(REAL.demoScene)).toEqual(['belts_that_join']);
    expect(lessonBoardIdLiteral(REAL.types)).toBe('belts_that_join');
  });

  it(`holds each machine Belts that join declares to a Place line in ${BOARD_FILE}`, () => {
    expect(declaredKeyFindings(BELTS_THAT_JOIN, REAL.ron, BOARD_FILE)).toEqual([]);
  });

  it('holds the lesson board id to the one string LessonBoard::parse accepts', () => {
    expect(boardIdFindings(BELTS_THAT_JOIN, REAL.types, REAL.demoScene, BOARD_FILE)).toEqual([]);
  });

  it("holds the Tauri invoke key to the load_lesson_board command's board_id parameter", () => {
    expect(invokeKeyFindings(REAL.channel, REAL.appLib)).toEqual([]);
  });

  it(`holds the ring cell Belts that join declares to the cell past the last DrawBelt cell in ${BOARD_FILE}`, () => {
    expect(ringFindings(BELTS_THAT_JOIN, REAL.ron, BOARD_FILE)).toEqual([]);
  });

  describe('fails on', () => {
    it('a Place line moved in the board file only', () => {
      const moved = REAL.ron.replace('Place(kind: 7, cell_x: 6, cell_y: 6)', 'Place(kind: 7, cell_x: 6, cell_y: 7)');
      expect(moved, 'the substitution landed').not.toBe(REAL.ron);
      expect(declaredKeyFindings(BELTS_THAT_JOIN, moved, BOARD_FILE).join('\n')).toMatch(/declares its sink as 7@6,6, and no Place line/);
    });

    it('a parse arm renamed in the host', () => {
      const renamed = REAL.demoScene.replace('"belts_that_join" => Some(Self::BeltsThatJoin)', '"belts-that-join" => Some(Self::BeltsThatJoin)');
      expect(renamed, 'the substitution landed').not.toBe(REAL.demoScene);
      expect(boardIdFindings(BELTS_THAT_JOIN, REAL.types, renamed, BOARD_FILE).join('\n')).toMatch(/accepts "belts-that-join"/);
    });

    it('a DrawBelt cut short in the board file only', () => {
      const cut = REAL.ron.replace('DrawBelt(cells: [(2, 2), (3, 2), (4, 2), (5, 2)])', 'DrawBelt(cells: [(2, 2), (3, 2), (4, 2)])');
      expect(cut, 'the substitution landed').not.toBe(REAL.ron);
      expect(ringFindings(BELTS_THAT_JOIN, cut, BOARD_FILE).join('\n')).toMatch(/declares its ring cell as \(6,2\), .* stepping on from \(3,2\) and \(4,2\), is \(5,2\)/);
    });

    it('the invoke key renamed', () => {
      const renamed = REAL.channel.replace("invoke('load_lesson_board', { boardId: arg })", "invoke('load_lesson_board', { board: arg })");
      expect(renamed, 'the substitution landed').not.toBe(REAL.channel);
      expect(invokeKeyFindings(renamed, REAL.appLib).join('\n')).toMatch(/with the key board, which Tauri maps to board, and the command's parameter .* is board_id/);
    });
  });
});
