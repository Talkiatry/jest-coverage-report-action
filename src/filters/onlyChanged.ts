import { Annotation } from '../annotations/Annotation';
import { buildLineIndex, LineIndex } from '../utils/buildLineIndex';

export function onlyChanged(
    annotations: Annotation[],
    patchContent: string
): Annotation[] {
    const addedLines: LineIndex = buildLineIndex(patchContent);
    return annotations.filter((a) => isInAddedLines(a, addedLines));
}

function isInAddedLines(a: Annotation, addedLines: LineIndex): boolean {
    return [...range(a.start_line, a.end_line)].some((line: number) =>
        addedLines[a.path]?.some((added) => added === line)
    );
}

function* range(start: number, end: number) {
    for (let i = start; i <= end; ++i) {
        yield i;
    }
}
