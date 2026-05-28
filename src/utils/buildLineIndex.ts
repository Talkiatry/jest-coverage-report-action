import parseDiff from 'parse-diff';

export type LineIndex = { [filepath: string]: number[] | undefined };

export function buildLineIndex(patchContent: string): LineIndex {
    const patch = parseDiff(patchContent);
    const addedLines: LineIndex = {};
    for (const file of patch) {
        if (file.to) {
            if (!addedLines[file.to]) {
                addedLines[file.to] = [];
            }
            const lines = addedLines[file.to]!;
            for (const chunk of file.chunks) {
                for (const change of chunk.changes) {
                    if (change.type === 'add') {
                        lines.push(change.ln);
                    }
                }
            }
        }
    }
    return addedLines;
}
