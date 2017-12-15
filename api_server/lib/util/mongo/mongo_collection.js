// Provides the MongoCollection object, a wrapper to the node mongo driver's Collection object,
// providing ease-of-use functions and built-in query logging

'use strict';

var BoundAsync = require(process.env.CS_API_TOP + '/lib/util/bound_async');
var ObjectID = require('mongodb').ObjectID;
var ErrorHandler = require(process.env.CS_API_TOP + '/lib/util/error_handler');
const Errors = require('./errors');

// bridges an $addToSet operation to mongo by allowing the caller to specify an
// array of elements to add without having to use the $each directive ... otherwise
// the array of elements is interpreted as a single element to add
// we're trying to shield the caller from the mongo implementation detail as much
// as possible for the most common use case
let _mongoAddToSetValue = function(value) {
	let mongoValue = {};
	Object.keys(value).forEach(fieldName => {
		let fieldValue = value[fieldName];
		if (fieldValue instanceof Array) {
			mongoValue[fieldName] = { $each: fieldValue };
		}
		else {
			mongoValue[fieldName] = fieldValue;
		}
	});
	return mongoValue;
};

// these ops are intended to shield the caller from mongo's implementation details,
// but in practice we're basically using the same ops (with the subtle difference of
// $addToSet) ... expanded implementations may change this behavior somewhat
const OP_TO_DB_OP = {
	'$set': '$set',
	'$unset': '$unset',
	'$addToSet': {
		dbOp: '$addToSet',
		valueFunc: _mongoAddToSetValue
	},
	'$push': '$push',
	'$pull': '$pull',
	'$inc': '$inc'
};

class MongoCollection {

	constructor (options) {
		this.options = options;
		this.idAttribute = options.idAttribute || '_id';
		this.dbCollection = options.dbCollection;
		if (!this.dbCollection) {
			throw 'no dbCollection in constructing MongoCollection';
		}
		this.errorHandler = new ErrorHandler(Errors);
	}

	// run a generic query, processing arguments as needed, and logging the query
	// for performance analysis
	runQuery (mongoFunc, query, callback, options, ...args) {
		options = options || {};
		const startTime = Date.now();
		const requestId = options.requestId;
		delete options.requestId;

		// called when the query is complete, this is where we'll do our logging
		let queryCallback = (error, results) => {
			const time = Date.now() - startTime;
			let logOptions = { query, mongoFunc, time, requestId, error };
			logOptions.queryOptions = options;
			this._logMongoQuery(logOptions, args);
			if (error) {
				return callback(this.errorHandler.dataError(error));
			}
			else {
				callback(null, results);
			}
		};

		let mongoArgs = [query, ...args, options, queryCallback];
		this.dbCollection[mongoFunc].apply(
			this.dbCollection,
			mongoArgs
		);
	}

	// get a document by its ID, we'll shield the caller from having to maintain
	// a mongo ID; they can use a simple string instead
	getById (id, callback, options) {
		let query = {};
		query[this.idAttribute] = this.objectIdSafe(id); // convert to mongo ID
		if (!query[this.idAttribute]) {
			// no document if no ID!
			return callback(null, null);
		}
		this.runQuery(
			'findOne',
			query,
			(error, result) => {
				// turn any IDs we see into strings
				this._idStringifyResult(error, result, callback);
			},
			options
		);
	}

	// get several documents by their IDs, we'll shield the caller from having to maintain
	// a mongo ID; they can use a simple string instead
	getByIds (ids, callback, options) {
		let query = {};
		let objectIds = [];
		// for each ID, convert it into a mongo ID
		BoundAsync.forEachLimit(
			this,
			ids,
			50,
			(id, foreachCallback) => {
				objectIds.push(this.objectIdSafe(id));
				process.nextTick(foreachCallback);
			},
			() => {
				// now run the actual query using $in
				query[this.idAttribute] = { $in: objectIds };
				this.getByQuery(query, callback, options);
			}
		);
	}

	// get several documents according to the specified query, providing sort, limit, and fields options
	// optional streaming of the results is also supported
	getByQuery (query, callback, options = {}) {
		let cursor = this.dbCollection.find(query);
		if (options.sort) {
			cursor = cursor.sort(options.sort);
		}
		if (options.limit) {
			cursor = cursor.limit(options.limit);
		}
		let project = {};
		if (options.fields) {
			options.fields.forEach(field => {
				project[field] = 1;
			});
		}
		const startTime = Date.now();

		// log the query here
		let logQuery = (error) => {
			const requestId = options.requestId;
			delete options.requestId;
			const time = Date.now() - startTime;
			const mongoFunc = 'find';
			let logOptions = { query, mongoFunc, time, requestId, error };
			logOptions.queryOptions = options;
			this._logMongoQuery(logOptions);
		};

		// called with the results
		let queryCallback = (error, results) => {
			logQuery(error);
			if (error) {
				return callback(this.errorHandler.dataError(error));
			}
			else {
				callback(null, results);
			}
		};

		if (!options.stream) {
			// the projection is for fields
			cursor.project(project).toArray((error, result) => {
				// turn any IDs we see into strings
				this._idStringifyResult(error, result, queryCallback);
			});
		}
		else {
			// stream the results, passing back just the cursor, the caller will
			// be responsible for iterating
			return callback(
				null,
				{
					cursor: cursor,
					done: (error, results) => {
						logQuery(error, results);
					}
				}
			);
		}
	}

	// get a single document (first we find) according to the specified query
	getOneByQuery (query, callback, options) {
		this.runQuery(
			'findOne',
			query,
			(error, result) => {
				// turn any IDs we see into strings
				this._idStringifyResult(error, result, callback);
			},
			options
		);
	}

	// create a document
	create (document, callback, options) {
		// get an ID in mongo ID form, or generate one
		document._id = document._id ? this.objectIdSafe(document._id) : ObjectID();
		// insert the document
		this.runQuery(
			'insertOne',
			document,
			(error) => {
				if (error) {
					return callback(this.errorHandler.dataError(error));
				}
				else {
					// to return the document, turn any IDs we see into strings
					this._idStringify(document, callback);
				}
			},
			options
		);
	}

	// create many documents
	createMany (documents, callback, options) {
		this.runQuery(
			'insertMany',
			documents,
			(error, result) => {
				// to return the documents, turn any IDs we see into strings
				this._idStringifyResult(error, result.ops, callback);
			},
			options
		);
	}

	// update a document
	update (document, callback, options) {
		let id = document[this.idAttribute];
		if (!id) {
			// must have an ID to update!
			return callback(this.errorHandler.error('id', { info: this.idAttribute }));
		}
		this.updateById(id, document, callback, options);
	}

	// update a document with an explicitly provided ID
	updateById (id, data, callback, options) {
		delete data._id; // since we're using the explicit ID, we'll ignore the one in the data
		// apply a $set to the data
		this._applyMongoOpById(
			id,
			{ $set: data },
			callback,
			options
		);
	}

	// apply a series of ops (directives) to modify the data associated with the specified
	// document
	applyOpsById (id, ops, callback, options) {
		// just break these down and do them one by one, no better way
		BoundAsync.forEachSeries(
			this,
			ops,
			(op, foreachCallback) => {
				this.applyOpById(id, op, foreachCallback, options);
			},
			callback
		);
	}

	// apply a single op (directive) to modify the data associated with the specified document
	applyOpById (id, op, callback, options) {
		let mongoOp = this.opToDbOp(op); // convert into mongo language
		this._applyMongoOpById(id, mongoOp, callback, options);
	}

	// convert ops from the more generic form into mongo language ... for now, the generic form
	// is VERY similar to mongo, but this allows the flexibility to change/enhance in the future
	opToDbOp (op) {
		let dbOp = {};
		Object.keys(OP_TO_DB_OP).forEach(opKey => {
			let opValue = op[opKey];
			if (typeof opValue === 'object') {
				let conversion = OP_TO_DB_OP[opKey];
				if (typeof conversion === 'object') {
					// here we handle differences between how mongo works and how we want to work,
					// by invoking a function to convert the value, rather than just taking it literally
					dbOp[conversion.dbOp] = conversion.valueFunc(opValue);
				}
				else {
					 dbOp[conversion] = opValue;
				}
			}
		});
		return dbOp;
	}

	// apply a mongo op to a document
	_applyMongoOpById (id, op, callback, options) {
		let query = {};
		query[this.idAttribute] = this.objectIdSafe(id) || id;
		this.runQuery(
			'updateOne',
			query,
			callback,
			options,
			op
		);
	}

	// update documents directly, the caller can do whatever they want with the database
	updateDirect (query, data, callback, options) {
		this.runQuery(
			'updateMany',
			query,
			callback,
			options,
			data
		);
	}

	// do a find-and-modify operation, a cheap atomic operation
	findAndModify (query, data, callback, options = {}) {
		this.runQuery(
			'findAndModify',
			query,
			callback,
			options,
			{},
			data,
			options.databaseOptions
		);
	}

	// delete a document by id
	deleteById (id, callback, options) {
		let query = {
			[this.idAttribute]: this.objectIdSafe(id)
		};
		this.runQuery(
			'deleteOne',
			query,
			callback,
			options
		);
	}

	// delete several documents by id
	deleteByIds (ids, callback, options) {
		let query = {};
		let objectIds = [];
		// we'll make a query out of the IDs
		BoundAsync.forEachLimit(
			this,
			ids,
			50,
			(id, foreachCallback) => {
				objectIds.push(this.objectIdSafe(id));
				process.nextTick(foreachCallback);
			},
			() => {
				query[this.idAttribute] = { $in: objectIds };
				this.deleteByQuery(query, callback, options);
			}
		);
	}

	// delete documents by query ... VERY DANGEROUS!!!
	deleteByQuery (query, callback, options) {
		this.runQuery(
			'deleteMany',
			query,
			callback,
			options
		);
	}

	// helper JSON.stringify to clean up whitespace
	_jsonStringify (json) {
		return JSON.stringify(json).
			replace(/\n/g,'').
			replace(/\s+/g, ' ');
	}

	// log a mongo query to our logger
	_logMongoQuery (options, ...args) {
		if (!this.options.queryLogger) {
			return;
		}
		this._logMongoQueryToLogger(this.options.queryLogger, options, args);
	}

	// log a mongo query to our logger
	_logMongoQueryToLogger (logger, options, ...args) {
		let {
			error = null,
			query = {},
			time = 0,
			mongoFunc = '???',
			requestId = 'NOREQ',
			queryOptions = {},
			noSlow = false
		} = options;
		let queryString = this._jsonStringify(query);
		let optionsString = this._jsonStringify(queryOptions);
		let additionalArgumentsString = this._jsonStringify(args || {});
		let fullQuery = `${requestId} db.${this.dbCollection.collectionName}.${mongoFunc}(${queryString},${optionsString},${additionalArgumentsString})`;
		logger.log(`${fullQuery}|${time}|${error}`);
		if (
			!noSlow &&
			this.options.slowLogger &&
			this.options.slowLogger.slowThreshold &&
			time >= this.options.slowLogger.slowThreshold
		) {
			// this query was slow, log it to the slow-query log
			delete options.noSlow;
			this._logMongoQueryToLogger(this.options.slowLogger, Object.assign({}, options, {noSlow: true}), args);
		}
		if (
			!noSlow &&
			this.options.reallySlowLogger &&
			this.options.reallySlowLogger.slowThreshold &&
			time >= this.options.reallySlowLogger.slowThreshold
		) {
			// this query was REALLY slow, log it to the really-slow-query log
			delete options.noSlow;
			this._logMongoQueryToLogger(this.options.reallySlowLogger, Object.assign({}, options, {noSlow: true}), args);
		}
	}

	// return a mongo ID, given a mongo ID or a string representation
	objectIdSafe (id) {
		try {
			id = ObjectID(id);
		}
		catch(error) {
			return null;
		}
		return id;
	}

	// create a new ID
	createId () {
		return ObjectID();
	}

	// handle the result of a query by stringifying any IDs we find before
	// returning the result to the caller
	_idStringifyResult (error, result, callback) {
		if (error) {
			return callback(this.errorHandler.dataError(error));
		}
		this._idStringify(result, callback);
	}

	// look for IDs or arrays of IDs in an object and stringify them, so the application layer
	// doesn't have to deal with mongo IDs
	_idStringify (object, callback) {
		if (object instanceof Array) {
			this._idStringifyAsync(object, callback);
		}
		else if (object && typeof object === 'object') {
			if (object[this.idAttribute]) {
				object[this.idAttribute] = object[this.idAttribute].toString();
			}
			return process.nextTick(() => {
				callback(null, object);
			});
		}
		else {
			return callback(null, object);
		}
	}

	// handle sub-objects and stringify all IDs
	_idStringifyAsync (objects, callback) {
		BoundAsync.forEachLimit(
			this,
			objects,
			100,
			this._idStringify,
			() => {
				callback(null, objects);
			}
		);
	}
}

module.exports = MongoCollection;
