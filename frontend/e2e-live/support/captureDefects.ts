import type { Grade } from './boardMeasure';
import type { AaSetting, CaptureCell, CaptureZoom, PropertyId } from './captureMatrix';

// captureDefects.ts - stub: the declared expected-failure table and its rule are not written yet.

export interface DeclaredDefect {
  property: PropertyId;
  dpr: number;
  aa: AaSetting;
  zoom: CaptureZoom;
  fixes: 'STRK-01' | 'STRK-02' | 'STRK-03';
  offenders: readonly string[];
  why: string;
}

export const DECLARED_DEFECTS: readonly DeclaredDefect[] = [];

export function declaredDefect(_property: PropertyId, _cell: CaptureCell): DeclaredDefect | undefined {
  return undefined;
}

export function checkDeclared(_row: DeclaredDefect, _result: Grade): string[] {
  return [];
}

export function runGradeCell(
  _cell: CaptureCell,
  _row: DeclaredDefect | undefined,
  _grade: (cell: CaptureCell) => Grade,
  _markExpectedFailure: () => void,
): void {}
