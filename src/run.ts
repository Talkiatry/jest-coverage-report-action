import { setFailed, setOutput } from '@actions/core';
import { context, getOctokit } from '@actions/github';

import { createCoverageAnnotations } from './annotations/createCoverageAnnotations';
import { createFailedTestsAnnotations } from './annotations/createFailedTestsAnnotations';
import { onlyChanged } from './filters/onlyChanged';
import { formatCoverageAnnotations } from './format/annotations/formatCoverageAnnotations';
import { formatFailedTestsAnnotations } from './format/annotations/formatFailedTestsAnnotations';
import { generateCommitReport } from './report/generateCommitReport';
import { generatePRReport } from './report/generatePRReport';
import { checkThreshold } from './stages/checkThreshold';
import { createReport } from './stages/createReport';
import { createRunReport } from './stages/createRunReport';
import { getCoverage } from './stages/getCoverage';
import {
    checkoutRef,
    getCurrentBranch,
    switchBranch,
} from './stages/switchBranch';
import { JsonReport } from './typings/JsonReport';
import { getOptions } from './typings/Options';
import { buildLineIndex } from './utils/buildLineIndex';
import { createDataCollector, DataCollector } from './utils/DataCollector';
import { filterCoverageMapToChangedLines } from './utils/filterCoverageMapToChangedLines';
import { getNormalThreshold } from './utils/getNormalThreshold';
import { getPrPatch } from './utils/getPrPatch';
import { i18n } from './utils/i18n';
import { runStage } from './utils/runStage';
import { upsertCheck } from './utils/upsertCheck';

export const run = async (
    dataCollector = createDataCollector<JsonReport>()
) => {
    const [isInitialized, options] = await runStage(
        'initialize',
        dataCollector,
        getOptions
    );
    const isInPR = !!options?.pullRequest;

    if (!isInitialized || !options) {
        throw Error('Initialization failed.');
    }

    const [isThresholdParsed, threshold] = await runStage(
        'parseThreshold',
        dataCollector,
        () => {
            return getNormalThreshold(
                options.workingDirectory ?? process.cwd(),
                options.threshold
            );
        }
    );

    const [, initialBranch] = await runStage(
        'getBranch',
        dataCollector,
        (skip) => {
            if (!isInPR) {
                skip();
            }

            return getCurrentBranch();
        }
    );

    const [isHeadSwitched] = await runStage(
        'switchToHead',
        dataCollector,
        async (skip) => {
            const head = options?.pullRequest?.head;

            // no need to switch branch when:
            // - this is not a PR
            // - this is the PR head branch
            // - a head coverage is provided
            if (!isInPR || !head || !!options.coverageFile) {
                skip();
            }

            await checkoutRef(head!, 'covbot-pr-head-remote', 'covbot/pr-head');
        }
    );

    const [isHeadCoverageGenerated, headCoverage] = await runStage(
        'headCoverage',
        dataCollector,
        async (skip) => {
            if (isInPR && !isHeadSwitched && !options.coverageFile) {
                skip();
            }

            return await getCoverage(
                dataCollector,
                options,
                false,
                options.coverageFile
            );
        }
    );

    const [, filteredHeadCoverage] = await runStage(
        'filterCoverage',
        dataCollector,
        async (skip) => {
            if (
                options.coverageScope !== 'changed-lines' ||
                !isInPR ||
                !isHeadCoverageGenerated
            ) {
                skip();
            }

            const octokit = getOctokit(options.token);
            const patch = await getPrPatch(octokit, options);
            const lineIndex = buildLineIndex(patch);
            const filteredCoverageMap = filterCoverageMapToChangedLines(
                headCoverage!,
                lineIndex,
                options.workingDirectory
            );
            return { ...headCoverage!, coverageMap: filteredCoverageMap };
        }
    );

    const filteredFileCount = filteredHeadCoverage
        ? Object.keys(filteredHeadCoverage.coverageMap).length
        : -1;
    const filteringApplied = filteredFileCount > 0;
    const effectiveCoverage = filteringApplied
        ? filteredHeadCoverage
        : headCoverage;
    if (effectiveCoverage) {
        dataCollector.add(effectiveCoverage);
    }

    const [isSwitched] = await runStage(
        'switchToBase',
        dataCollector,
        async (skip) => {
            const base = options?.pullRequest?.base;

            // no need to switch branch when:
            // - this is not a PR
            // - this is the PR base branch
            // - a base coverage is provided
            // - using changed-lines scope (base comparison is skipped)
            if (
                !isInPR ||
                !base ||
                !!options.baseCoverageFile ||
                options.coverageScope === 'changed-lines'
            ) {
                skip();
            }

            await checkoutRef(base!, 'covbot-pr-base-remote', 'covbot/pr-base');
        }
    );

    const ignoreCollector = createDataCollector<JsonReport>();

    const [, baseCoverage] = await runStage(
        'baseCoverage',
        dataCollector,
        async (skip) => {
            if (
                (!isSwitched && !isHeadSwitched && !options.baseCoverageFile) ||
                options.coverageScope === 'changed-lines'
            ) {
                skip();
            }

            return await getCoverage(
                ignoreCollector,
                options,
                true,
                options.baseCoverageFile
            );
        }
    );

    await runStage('switchBack', dataCollector, (skip) => {
        if (!initialBranch) {
            console.warn(
                'Not checked out to the original branch - failed to get it.'
            );
            skip();
        }

        return switchBranch(initialBranch!);
    });

    if (baseCoverage) {
        dataCollector.add(baseCoverage);
    }

    const [, thresholdResults] = await runStage(
        'checkThreshold',
        dataCollector,
        async (skip) => {
            if (!isHeadCoverageGenerated || !isThresholdParsed) {
                skip();
            }

            return checkThreshold(
                effectiveCoverage!,
                threshold!,
                options.workingDirectory,
                dataCollector as DataCollector<unknown>
            );
        }
    );

    const [isRunReportGenerated, runReport] = await runStage(
        'generateRunReport',
        dataCollector,
        (skip) => {
            if (!isHeadCoverageGenerated) {
                skip();
            }

            return createRunReport(headCoverage!);
        }
    );

    await runStage('failedTestsAnnotations', dataCollector, async (skip) => {
        if (
            !isHeadCoverageGenerated ||
            !isRunReportGenerated ||
            !['all', 'failed-tests'].includes(options.annotations)
        ) {
            skip();
        }

        const failedAnnotations = createFailedTestsAnnotations(headCoverage!);

        const octokit = getOctokit(options.token);
        await upsertCheck(
            octokit,
            formatFailedTestsAnnotations(runReport!, failedAnnotations, options)
        );
    });

    await runStage('coverageAnnotations', dataCollector, async (skip) => {
        if (
            !isHeadCoverageGenerated ||
            !['all', 'coverage'].includes(options.annotations)
        ) {
            skip();
        }

        let coverageAnnotations = createCoverageAnnotations(headCoverage!);

        if (coverageAnnotations.length === 0) {
            skip();
        }

        const octokit = getOctokit(options.token);
        if (options.pullRequest?.number) {
            const patch = await getPrPatch(octokit, options);
            coverageAnnotations = onlyChanged(coverageAnnotations, patch);
        }
        await upsertCheck(
            octokit,
            formatCoverageAnnotations(coverageAnnotations, options)
        );
    });

    const totalFileCount = headCoverage
        ? Object.keys(headCoverage.coverageMap).length
        : 0;
    const coverageNote = filteringApplied
        ? `> [!NOTE]\n> Coverage reflects **changed lines only** — metrics are scoped to statements, branches, and functions on lines added or modified in this PR (${filteredFileCount} of ${totalFileCount} file(s)). No base branch comparison is shown.\n`
        : filteredFileCount === 0
        ? `> [!WARNING]\n> No changed source files were found in the coverage report. Showing full project coverage instead.\n`
        : undefined;

    const [isReportContentGenerated, summaryReport] = await runStage(
        'generateReportContent',
        dataCollector,
        async () => {
            return createReport(
                dataCollector,
                runReport,
                options,
                thresholdResults ?? [],
                coverageNote
            );
        }
    );

    await runStage('publishReport', dataCollector, async (skip) => {
        if (!isReportContentGenerated || !options.output.includes('comment')) {
            skip();
        }

        const octokit = getOctokit(options.token);

        if (isInPR) {
            await generatePRReport(
                summaryReport!.text,
                options,
                context.repo,
                options.pullRequest as { number: number },
                octokit
            );
        } else {
            await generateCommitReport(
                summaryReport!.text,
                context.repo,
                octokit
            );
        }
    });

    await runStage('setOutputs', dataCollector, (skip) => {
        if (
            !isReportContentGenerated ||
            !options.output.includes('report-markdown')
        ) {
            skip();
        }

        if (options.output.includes('report-markdown')) {
            setOutput('report', summaryReport!.text);
        }
    });

    if (dataCollector.get().errors.length > 0) {
        setFailed(i18n('failed'));
    }
};
