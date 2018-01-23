// attributes that apply to all CodeSteam models

'use strict';

module.exports = {
	_id: {
		type: 'id'
	},
	createdAt: {
		type: 'timestamp',
		required: true
	},
	deactivated: {
		type: 'boolean',
		required: true
	},
	modifiedAt: {
		type: 'timestamp',
		required: true
	},
	creatorId: {
		type: 'id'
	},
	_forTesting: {
		type: 'boolean',
		serverOnly: true
	}
};
