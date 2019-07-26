// base class for many tests of the "POST /team-tags/:id" requests

'use strict';

const BoundAsync = require(process.env.CS_API_TOP + '/server_utils/bound_async');
const CodeStreamAPITest = require(process.env.CS_API_TOP + '/lib/test_base/codestream_api_test');
const UUID = require('uuid/v4');
const RandomString = require('randomstring');
const DefaultTags = require('../../default_tags');
const DeepClone = require(process.env.CS_API_TOP + '/server_utils/deep_clone');

class CommonInit {

	init (callback) {
		this.teamOptions.creatorIndex = 1;
		this.userOptions.numRegistered = 3;
		BoundAsync.series(this, [
			CodeStreamAPITest.prototype.before.bind(this),
			this.makeTagData	// make the data to be used during the update
		], callback);
	}
	
	// form the data for the team update
	makeTagData (callback) {
		this.path = '/team-tags/' + this.team.id;
		const id = UUID().split('-').join('');
		this.data = {
			id,
			color: RandomString.generate(6),
			label: RandomString.generate(20)
		};
		this.updatedAt = Date.now();
		const expectedData = { ...this.data };
		delete expectedData.id;
		this.expectedResponse = {
			team: {
				id: this.team.id,
				_id: this.team.id,
				$set: {
					[`tags.${id}`]: expectedData,
					modifiedAt: Date.now(),
					version: 5
				},
				$version: {
					before: 4,
					after: 5
				}
			}
		};
		this.expectedTags = DeepClone(DefaultTags);
		this.expectedTags[id] = expectedData;
		callback();
	}

	// create the actual tag
	createTag (callback) {
		this.doApiRequest(
			{
				method: 'post',
				path: '/team-tags/' + this.team.id,
				data: this.data,
				token: this.token
			},
			(error, response) => {
				if (error) { return callback(error); }
				this.createTagResponse = response;
				delete this.data;	// don't need this anymore
				callback();
			}
		);
	}
}

module.exports = CommonInit;
