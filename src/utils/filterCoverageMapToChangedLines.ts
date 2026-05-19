import { join } from 'path';

import {
    ArrayHitMap,
    BranchMap,
    CoverageMap,
    FileCoverage,
    FunctionMap,
    HitMap,
    JsonReport,
    StatementMap,
} from '../typings/JsonReport';
import { LineIndex } from './buildLineIndex';

export function filterCoverageMapToChangedLines(
    jsonReport: JsonReport,
    lineIndex: LineIndex,
    workingDirectory?: string
): CoverageMap {
    const cwd = workingDirectory
        ? join(process.cwd(), workingDirectory)
        : process.cwd();

    const result: CoverageMap = {};

    for (const [absolutePath, rawFileCoverage] of Object.entries(
        jsonReport.coverageMap
    )) {
        const relativePath = absolutePath.startsWith(cwd + '/')
            ? absolutePath.substring(cwd.length + 1)
            : absolutePath;

        const addedLines = lineIndex[relativePath];
        if (!addedLines || addedLines.length === 0) {
            continue;
        }

        const addedLineSet = new Set(addedLines);
        const fileCoverage =
            'statementMap' in rawFileCoverage
                ? rawFileCoverage
                : rawFileCoverage.data;

        result[absolutePath] = filterFileCoverage(fileCoverage, addedLineSet);
    }

    return result;
}

function intersectsChangedLines(
    start: number,
    end: number,
    addedLines: Set<number>
): boolean {
    for (let line = start; line <= end; line++) {
        if (addedLines.has(line)) return true;
    }
    return false;
}

function filterFileCoverage(
    coverage: FileCoverage,
    addedLines: Set<number>
): FileCoverage {
    const filteredStatementMap: StatementMap = {};
    const filteredS: HitMap = {};
    for (const [id, stCov] of Object.entries(coverage.statementMap)) {
        const numId = Number(id);
        if (
            intersectsChangedLines(
                stCov.start.line,
                stCov.end.line,
                addedLines
            )
        ) {
            filteredStatementMap[numId] = stCov;
            filteredS[numId] = coverage.s[numId];
        }
    }

    const filteredFnMap: FunctionMap = {};
    const filteredF: HitMap = {};
    for (const [id, fnCov] of Object.entries(coverage.fnMap)) {
        const numId = Number(id);
        const start = fnCov.loc.start?.line ?? fnCov.decl.start?.line;
        const end = fnCov.loc.end?.line ?? fnCov.decl.end?.line;
        if (
            start !== undefined &&
            end !== undefined &&
            intersectsChangedLines(start, end, addedLines)
        ) {
            filteredFnMap[numId] = fnCov;
            filteredF[numId] = coverage.f[numId];
        }
    }

    const filteredBranchMap: BranchMap = {};
    const filteredB: ArrayHitMap = {};
    for (const [id, branchCov] of Object.entries(coverage.branchMap)) {
        const numId = Number(id);
        const start = branchCov.loc.start?.line;
        const end = branchCov.loc.end?.line;
        if (
            start !== undefined &&
            end !== undefined &&
            intersectsChangedLines(start, end, addedLines)
        ) {
            filteredBranchMap[numId] = branchCov;
            filteredB[numId] = coverage.b[numId];
        }
    }

    return {
        ...coverage,
        statementMap: filteredStatementMap,
        s: filteredS,
        fnMap: filteredFnMap,
        f: filteredF,
        branchMap: filteredBranchMap,
        b: filteredB,
    };
}
