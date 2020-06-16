'use strict';

const DeleteTagTest = require('./delete_tag_test');
const Assert = require('assert');
const BoundAsync = require(process.env.CSSVC_BACKEND_ROOT + '/shared/server_utils/bound_async');

class FetchTest extends DeleteTagTest {

	get description () {
		return 'should delete a tag for a team when requested, checked by fetching the team';
	}

	// run the actual test...
	run (callback) {
		// we'll run the update, but also verify the update took by fetching and validating
		// the team object
		BoundAsync.series(this, [
			super.run,
			this.validateTeamObject
		], callback);
	}

	// fetch and validate the team object against the update we made
	validateTeamObject (callback) {
		this.doApiRequest({
			method: 'get',
			path: '/teams/' + this.team.id,
			token: this.token
		}, (error, response) => {
			if (error) { return callback(error); }
			Assert.deepEqual(response.team.tags, this.expectedTags);
			callback();
		});
	}
}

module.exports = FetchTest;
