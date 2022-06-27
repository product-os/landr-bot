/*
 * Copyright 2020 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { find, get } from 'lodash';
import { promises } from 'fs';
import { resolve } from 'path';
import { sync } from 'rimraf';
import { serializeError } from 'serialize-error';

import { run, getNetlifySiteName } from 'landr/lib/build-runner';

import { getMetaData } from 'landr/lib/meta-generator/getMetaData';
import { findSite, deleteSite } from 'landr/lib/netlify';
import { Context, Probot } from 'probot';
import { DeprecatedLogger } from 'probot/lib/types';

// TODO: Infer this login information automatically
// This is the identifier GitHub uses for the bot
const LANDR_BOT_LOGIN = 'landrbot[bot]';

const fetchComments = async (context: Context, owner: string, repo: string, pullNumber: number) => {
	let currentPage = 1;
	let comments: Awaited<ReturnType<Context['octokit']['issues']['listComments']>>['data'] = [];
	let hasNextPage = true;
	while (hasNextPage) {
		// In the GitHub API, comments directly on the pull request are considered
		// to be issue comments, whereas comments on the code are pull request
		// comments. Here we want to retrieve all comments directly on the PR, so we
		// need to use the issues API.
		const response = await context.octokit.issues.listComments({
			owner,
			repo,
			issue_number: pullNumber,
			per_page: 100,
			page: currentPage,
		});
		comments = comments.concat(response.data);
		if (response.headers.link && response.headers.link.includes('rel="next"')) {
			currentPage++;
		} else {
			hasNextPage = false;
		}
	}
	return comments;
};

const upsertPRComment = async ({
	context,
	owner,
	repo,
	pullNumber,
	message,
	log,
}: {
	context: Context;
	owner: string;
	repo: string;
	pullNumber: number;
	message: string;
	log: DeprecatedLogger;
}) => {
	// Don't post a comment on the PR if landr-bot has already posted one.

	const comments = await fetchComments(context, owner, repo, pullNumber);

	const existingComment = find(comments, ['user.login', LANDR_BOT_LOGIN]);

	if (existingComment) {
		log('updating existing comment on PR');

		await context.octokit.issues.updateComment({
			owner,
			repo,
			comment_id: existingComment.id,
			body: message,
		});
	} else {
		await context.octokit.issues.createComment({
			owner,
			repo,
			issue_number: pullNumber,
			body: message,
		});
	}
};

const build = async ({
	context,
	branch,
	log,
	pullNumber,
}: {
	context: Context<'push' | 'pull_request.opened' | 'pull_request.synchronize'>;
	branch: string;
	log: DeprecatedLogger;
	pullNumber?: number;
}) => {
	// If the payload is from a pull request, extract the repo name from the head
	// reference, as this will contain the correct repo name if the PR is a fork.
	// Otherwise the payload is from a push to the master branch.
	// @ts-expect-error ts-never pull request info will be missing on master push
	const repository = context.payload.pull_request
		? // @ts-expect-error ts-never
		  context.payload.pull_request.head.repo.full_name
		: context.payload.repository.full_name;

	const contract = await getMetaData(repository, branch, context, true);
	const [owner, repo] = repository.split('/');

	const outputBase = resolve(process.cwd(), '.landr-store', owner, repo, branch);
	const outputDir = resolve(outputBase, 'dist');
	const contractPath = resolve(outputBase, 'contract.json');

	// Wipe out output directory so that we start fresh every time.
	sync(outputDir);

	// Create the output directory
	await promises.mkdir(outputDir, {
		recursive: true,
	});

	// TODO: pass the contract data directly to the builder
	// Write the contract to a JSON file next to the output directory
	await promises.writeFile(contractPath, JSON.stringify(contract));

	const results = await run({
		contractPath,
		outputDir,
		branch,
		deploy: true,
		netlifyToken: process.env.NETLIFY_AUTH_TOKEN,

		quiet:
			process.env.QUIET_BUILDS == null // eslint-disable-line no-eq-null
				? true
				: process.env.QUIET_BUILDS === 'true',
		pullNumber,
		logger: log,
	});

	// After deployment, cleanup the build files
	sync(outputBase);

	return results.url;
};

// This is the main entrypoint to your Probot app
export default (app: Probot) => {
	app.on(['pull_request.closed'], async (context: Context<'pull_request.closed'>) => {
		const repository = context.payload.repository.full_name;
		const [owner, repo] = repository.split('/');
		const pullNumber = context.payload.number;
		const branch = get(context, ['payload', 'pull_request', 'head', 'ref']);
		if (branch === 'master') {
			return;
		}
		const netlifySiteName = getNetlifySiteName({
			owner,
			name: repo,
			pullNumber,
			branch,
		});
		const site = await findSite(process.env.NETLIFY_AUTH_TOKEN, netlifySiteName);
		if (site) {
			context.log(`Deleting preview site ${netlifySiteName} from netlify`);
			await deleteSite(process.env.NETLIFY_AUTH_TOKEN, site.id);

			await upsertPRComment({
				context,
				owner,
				repo,
				pullNumber,
				message: 'The preview site has been deleted.',
				log: context.log,
			} as any);
		}
	});

	app.on(
		['pull_request.opened', 'pull_request.synchronize'],
		async (context: Context<'pull_request.opened' | 'pull_request.synchronize'>) => {
			const { url } = context.payload.pull_request;
			const repository = context.payload.repository.full_name;
			const [owner, repo] = repository.split('/');
			const pullNumber = context.payload.number;

			context.log(`Triggering build for PR: ${url}`);

			const branch = get(context, ['payload', 'pull_request', 'head', 'ref']);

			try {
				const siteUrl = await build({
					context,
					branch,
					log: context.log,
					pullNumber,
				} as any);
				const message = `Your landr site preview has been successfully deployed to ${siteUrl}

*Deployed with Landr ${process.env.npm_package_version}*`;

				context.log(`posting site preview link in comment to PR: ${url}`);

				await upsertPRComment({
					context,
					owner,
					repo,
					pullNumber,
					message,
					log: context.log,
				} as any);
			} catch (error) {
				context.log.error('An error occurred', error);
				context.log(`Posting error message to PR: ${url}`);

				const reportableError = JSON.stringify(serializeError(error), null, 2);

				// On error, post the error as a GitHub comment
				const message = `An error occurred whilst building your landr site preview:
\`\`\`
${reportableError}
\`\`\``;

				await upsertPRComment({
					context,
					owner,
					repo,
					pullNumber,
					message,
					log: context.log,
				} as any);
			}
		}
	);

	app.on('push', async (context: Context<'push'>) => {
		if (context.payload.ref === 'refs/heads/master') {
			context.log(`Triggering build for master branch: ${context.payload.repository.html_url}`);
			const siteUrl = await build({
				context,
				branch: 'master',
				log: context.log,
			} as any);
			context.log(`Built master branch at ${siteUrl}`);
		}
	});
};
