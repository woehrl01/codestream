'use strict';

const ReviewMarkerStreamOnTheFlyTest = require('./review_marker_stream_on_the_fly_test');
const BoundAsync = require(process.env.CSSVC_BACKEND_ROOT + '/shared/server_utils/bound_async');
const TestTeamCreator = require(process.env.CSSVC_BACKEND_ROOT + '/api_server/lib/test_base/test_team_creator');

class OnTheFlyReviewMarkerStreamFromDifferentTeamTest extends ReviewMarkerStreamOnTheFlyTest {

	get description () {
		return 'should return an error when attempting to create a post and review with a marker for an on-the-fly stream where the stream is from a different team';
	}

	getExpectedError () {
		return {
			code: 'RAPI-1003',
			info: 'marker repo'
		};
	}

	// form the data we'll use in creating the post
	makePostData (callback) {
		// before forming the post data, we'll create a second repo and file-type
		// stream, we'll use this for the marker
		BoundAsync.series(this, [
			super.makePostData,
			this.createForeignTeam
		], callback);
	}

	createForeignTeam (callback) {
		new TestTeamCreator({
			test: this,
			teamOptions: Object.assign({}, this.teamOptions, {
				creatorIndex: null,
				creatorToken: this.users[1].accessToken,
				numAdditionalInvites: 0
			}),
			userOptions: this.userOptions,
			repoOptions: {
				creatorToken: this.users[1].accessToken
			}
		}).create((error, response) => {
			if (error) { return callback(error); }
			const marker = this.data.review.markers[0];
			Object.assign(marker, {
				repoId: response.repo.id,
				file: this.streamFactory.randomFile()
			});
			callback();
		});
	}
}

module.exports = OnTheFlyReviewMarkerStreamFromDifferentTeamTest;
