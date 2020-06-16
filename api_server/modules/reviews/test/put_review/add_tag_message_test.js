'use strict';

const Aggregation = require(process.env.CSSVC_BACKEND_ROOT + '/shared/server_utils/aggregation');
const MessageTest = require('./message_test');
const AddTagTest = require('./add_tag_test');

class AddTagMessageTest extends Aggregation(MessageTest, AddTagTest) {

	get description () {
		return `members of the stream or team should receive a message with the review when a tag is added to a review in a ${this.streamType} stream`;
	}
}

module.exports = AddTagMessageTest;
