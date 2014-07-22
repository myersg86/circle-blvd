// app.js
var express = require('express');
var events  = require('events');
var http    = require('http');
var path    = require('path');
var routes  = require('./routes');

var auth   = require('./lib/auth-local.js');
var ensure = require('./lib/auth-ensure.js');
var limits = require('./lib/limits.js');
var errors = require('./lib/errors.js');
var db     = require('./lib/dataAccess.js').instance();
var notify = require('./lib/notify.js');

var sslServer = require('./lib/https-server.js');
var payment   = require('./lib/payment.js')();
var settings  = require('./lib/settings.js');

var usersRoutes = require('./routes/users');
var userRoutes 	= require('./routes/user');
var initRoutes 	= require('./routes/init');

var couchSessionStore = require('./lib/couch-session-store.js');

var ee = new events.EventEmitter();
var isReady = false;

var app = express();


// Middleware for data access
var guard = errors.guard;

var handle = function (res) {
	var fn = guard(res, function (data) {
		if (!data) {
			return res.send(204); // no content
		}
		res.send(200, data);
	}); 
	return fn;
};

var send = function (fn) {
	var middleware = function (req, res, next) {
		fn(handle(res));
	};

	return middleware;
};

var data = function (fn) {
	// A generic guard for callbacks. Call the
	// fn parameter. If there is an error, pass
	// it up to the error handler. Otherwise
	// append the result to the request object,
	// for the next middleware in line.
	var middleware = function (req, res, next) {
		fn(guard(res, function (data) {
			if (req.data) {
				// TODO: programmer error
			}
			req.data = data;
			next();
		}));
	};

	return middleware;
};

var tryToCreateHttpsServer = function (callback) {
	sslServer.create(app, callback);
};

var defineRoutes = function () {
	app.post('/auth/signin', auth.signin);
	app.get('/auth/signout', auth.signout);

	// User routes (account actions. requires login access)
	app.get("/data/user", ensure.auth, userRoutes.user);
	app.put("/data/user/name", ensure.auth, userRoutes.updateName);
	app.put("/data/user/email", ensure.auth, userRoutes.updateEmail);
	app.put("/data/user/notificationEmail", ensure.auth, userRoutes.updateNotificationEmail)
	app.put("/data/user/password", ensure.auth, userRoutes.updatePassword);


	// User routes (circle actions. requires admin access)
	app.get("/data/:circleId/members", ensure.circleAdmin, function (req, res) {
		var circleId = req.params.circleId;
		db.users.findByCircleId(circleId, handle(res));
	});

	app.put("/data/:circleId/member/remove", ensure.circleAdmin, function (req, res) {
		var circleId = req.params.circleId;
		var reqUser = req.body;
		db.users.removeMembership(reqUser, circleId, handle(res));
	});

	app.post("/data/:circleId/member", ensure.circleAdmin, function (req, res) {
		var circleId = req.params.circleId;
		var member = req.body;
		db.users.addMembership(member, circleId, handle(res));
	});

	app.get("/data/:circleId/members/names", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.users.findNamesByCircleId(circleId, handle(res));
	});

	// Init routes
	app.put("/data/initialize", initRoutes.init);


	// Settings!
	app.get("/data/settings", send(db.settings.get)); // public

	// TODO: This is not used. Assess.
	app.get("/data/settings/private", 
		ensure.mainframe, send(db.settings.getPrivate)); 

	app.get("/data/settings/authorized", 
		ensure.mainframe, send(db.settings.getAuthorized));

	app.put("/data/setting", ensure.mainframe, function (req, res) {
		var data = req.body;
		var onSettingsUpdate = function (setting) {
			if (setting.name === 'ssl-key-path' || setting.name === 'ssl-cert-path') {
				// TODO: Tell the client if we started the server?
				tryToCreateHttpsServer();
			}
			if (setting.name === 'stripe-secret-key') {
				payment.setApiKey(setting.value);
			}
			res.send(200);
		};

		db.settings.update(data, guard(res, onSettingsUpdate));;
	});


	// Circles!
	app.get("/data/circles", ensure.auth, function (req, res) {
		db.circles.findByUser(req.user, handle(res));
	});

	app.get("/data/circles/all", 
		ensure.mainframe, 
		send(db.circles.getAll));

	app.post("/data/circle", 
		ensure.auth, limits.circle, limits.users.circle, function (req, res) {
		//
		var circleName = req.body.name;
		var user = req.user;

		if (!circleName) {
			var message = "A 'name' property is required, for naming the circle.";
			return res.send(400, message);
		}

		db.circles.create(circleName, user.email, handle(res));
	});

	app.post("/data/circle/admin", ensure.mainframe, function (req, res) {
		var circle = req.body.circle;
		var admin = req.body.admin;

		if (!admin.email) {
			var message = "An email address for an administrative user " +
				"is required when making a circle.";
			return res.send(400, message);
		}

		db.circles.create(circle.name, admin.email, handle(res));
	});

	app.put("/data/circle", ensure.mainframe, function (req, res) {
		var circle = req.body;
		db.circles.update(circle, handle(res));
	});


	// Groups!
	app.get("/data/:circleId/groups", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.groups.findByProjectId(circleId, handle(res));
	});

	// TODO: We'll turn groups on at a later time, as we
	// transition toward hosting larger groups, but in the 
	// mean time this is just a security hole.
	//
	// TODO: Ensure circle access
	// app.post("/data/group", ensureAdministrator, function (req, res) {
	// 	var data = req.body;

	// 	var group = {};	
	// 	group.projectId = data.projectId;
	// 	group.name = data.name;

	// 	db.groups.add(group, handle(res));
	// });

	// // TODO: Ensure circle access
	app.get("/data/group/:groupId", ensure.auth, function (req, res) {
		var groupId = req.params.groupId;
		db.groups.findById(groupId, handle(res));
	});

	// // TODO: Ensure circle access
	// app.put("/data/group/remove", ensureAdministrator, function (req, res) {
	// 	var group = req.body;

	// 	db.groups.remove(group, 
	// 		function () {
	// 			res.send(200);
	// 		},
	// 		function (err) {
	// 			errors.handle(err, res);
	// 		}
	// 	);
	// });


	// Story routes
	app.get("/data/:circleId/stories", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.stories.findByProjectId(circleId, handle(res));
	});

	// TODO: combine this with /stories to return one object with 
	// both the story list and the first story (in two different things)
	app.get("/data/:circleId/first-story", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.stories.getFirstByProjectId(circleId, handle(res));
	});

	app.get("/data/:circleId/archives", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		var query = req.query;
		var defaultLimit = 251; // TODO: Settings

		var limit = query.limit || defaultLimit;
		var startkey = query.startkey;
		var params = {
			limit: limit,
			startkey: startkey
		};

		db.archives.findByCircleId(circleId, params, handle(res));
	});

	app.get("/data/:circleId/archives/count", ensure.circle, function (req, res) {
		var circleId = req.params.circleId;
		db.archives.countByCircleId(circleId, guard(res, function (count) {
			res.send(200, count.toString());
		}));
	});

	var copyStory = function (story) {
		var copy = {};
		
		copy.projectId = story.projectId;
		copy.summary = story.summary;
		copy.isDeadline = story.isDeadline;
		copy.isNextMeeting = story.isNextMeeting;

		copy.createdBy = story.createdBy;
		copy.nextId = story.nextId;

		return copy;
	};

	var addStory = function (story, res) {
		db.stories.add(story, handle(res));
	};

	var getCreatedBy = function (req) {
		var createdBy = undefined;
		if (req.user) {
			createdBy = {
				name: req.user.name,
				id: req.user._id
			};
		}

		return createdBy;
	};

	// TODO: Ensure that the circleId specified in this
	// story is valid. Otherwise people can hack around
	// ways of accessing stories.
	//
	// This might be a thing to do at the data layer, or
	// we could do it higher up by getting the story
	// from the database and comparing the projectId to
	// the one specified, which might be a cleaner approach.
	app.post("/data/story/", ensure.auth, function (req, res) {
		var data = req.body;
		var circleId = data.projectId;
		ensure.isCircle(circleId, req, res, function() {
			// Add the story if we're under the server limit.
			limits.users.story(circleId, guard(res, function () {
				var story = copyStory(data);
				story.createdBy = getCreatedBy(req);
				addStory(story, res);
			}));
		});
	});

	var getComment = function (text, req) {
		var comment = {
			text: text,
			createdBy: getCreatedBy(req),
			timestamp: Date.now()
		};

		return comment;
	};

	var saveStoryWithComment = function (story, req, res) {
		db.stories.save(story, 
			function (savedStory) {
				if (story.newComment) {
					var params = {
						story: savedStory,
						comment: story.newComment,
						user: req.user
					};
					notify.newComment(params, req);	
				}
				res.send(200, savedStory);
			},
			function (err) {
				errors.handle(err, res);
			}
		);
	};

	app.put("/data/story/", ensure.auth, function (req, res) {
		var story = req.body;
		var commentText = undefined;
		ensure.isCircle(story.projectId, req, res, function () {
			// TODO: This is an opportunity to clean up the API?
			// In other words, add /data/story/comment? Maybe.
			if (story.newComment) {
				story.newComment = getComment(story.newComment, req);
			}
			saveStoryWithComment(story, req, res);
		});	
	});

	app.put("/data/story/comment", ensure.auth, function (req, res) {
		// circleId, storyId, comment
		var data = req.body;
		if (!data.circleId || !data.storyId || !data.comment) {
			return res.send(400, "Missing circleId, storyId or comment.");
		}

		ensure.isCircle(data.circleId, req, res, function () {
			db.docs.get(data.storyId, guard(res, function (story) {
				if (story.projectId !== data.circleId) {
					return res.send(400);
				}

				story.newComment = getComment(data.comment, req);
				saveStoryWithComment(story, req, res);
			}));
		});
	});

	app.get("/data/story/:storyId", ensure.auth, function (req, res) {
		var storyId = req.params.storyId;
		if (!storyId) {
			return res.send(400, "Story id required.");
		}

		db.docs.get(storyId, guard(res, function (story) {
			if (!story || story.type !== "story") {
				return res.send(400, "Story not found");
			}

			var circleId = story.projectId;
			ensure.isCircle(circleId, req, res, function () {
				res.send(200, story);
			});
		}));
	});

	app.put("/data/story/fix", ensure.auth, function (req, res) {
		var body = req.body;
		var story = body.story;
		var newNextId = body.newNextId;
		ensure.isCircle(story.projectId, req, res, function () {
			story.nextId = newNextId;
			db.stories.fix(story, function (response) {
				res.send(200, response);
			},
			function (err) {
				errors.handle(err, res);
			});
		});
	});

	app.put("/data/story/move", ensure.auth, function (req, res) {
		var body = req.body;
		var story = body.story;
		var newNextId = body.newNextId;
		ensure.isCircle(story.projectId, req, res, function () {
			db.stories.move(story, newNextId, handle(res));
		});
	});

	var removeStory = function (story, res) {
		db.stories.remove(story, handle(res));
	};

	app.put("/data/story/archive", ensure.auth, function (req, res) {
		var story = req.body;
		ensure.isCircle(story.projectId, req, res, function () {
			var stories = [];
			stories.push(story);

			db.archives.addStories(stories, 
			function (body) {
				// TODO: If this breaks then we have a data
				// integrity issue, because we have an archive
				// of a story that has not been deleted.
				removeStory(story, res);
			}, 
			function (err) {
				errors.handle(err, res);
			});
		});
	});

	app.put("/data/story/remove", ensure.auth, function (req, res) {
		var story = req.body;
		ensure.isCircle(story.projectId, req, res, function () {
			removeStory(story, res);
		});
	});


	app.post("/data/story/notify/new", ensure.auth, function (req, res) {
		var story = req.body;
		var sender = req.user;
		ensure.isCircle(story.projectId, req, res, function () {
			notify.newStory(story, sender, handle(res));
		});
	});

	// TODO: Where should this be on the client?
	app.put("/data/:circleId/settings/show-next-meeting", ensure.circleAdmin, function (req, res) {
		var showNextMeeting = req.body.showNextMeeting;
		var projectId = req.params.circleId;

		var handleNextMeeting = guard(res, function (nextMeeting) {
			if (showNextMeeting) {
				// TODO: Should probably be in the data access layer.
				// TODO: Consider passing in the summary from the client,
				// as 'meeting' should be a configurable word.
				var story = {};
				story.summary = "Next meeting";
				story.isNextMeeting = true;

				addStory(story, res);
			}
			else {
				removeStory(nextMeeting, res);
			}
		});

		var nextMeeting = db.stories.getNextMeetingByProjectId(projectId, handleNextMeeting);
	});

	app.post('/payment/donate', function (req, res) {
		var data = req.body;
		var stripeTokenId = data.stripeTokenId;
		var amount = data.stripeAmount

		payment.donate(stripeTokenId, amount, handle(res));
	});

	app.post('/payment/subscribe', ensure.auth, function (req, res) {
		var data = req.body;

		var user = req.user;
		var stripeTokenId = data.stripeTokenId;
		var planName = data.planName;

		payment.subscribe(user, stripeTokenId, planName, handle(res));
	});

	app.put('/payment/subscribe/cancel', ensure.auth, function (req, res) {
		var user = req.user;
		if (!user.subscription) {
			return res.send(204);
		}

		payment.unsubscribe(user, handle(res));
	});

	var createAccount = function (proposedAccount, circle, callback) {
		var userAccountCreated = function (newAccount) {
			db.circles.create(circle.name, newAccount.email, callback);
		};

		var addUser = function () {
			var isReadOnly = false;
			db.users.add(
				proposedAccount.name,
				proposedAccount.email, 
				proposedAccount.password,
				[], // no memberships at first
				isReadOnly,
				userAccountCreated, 
				callback);
		};

		db.users.findByEmail(proposedAccount.email, function (err, accountExists) {
			if (err) {
				return callback(err);
			}
			if (accountExists) {
				var error = new Error("That email address is already being used. Maybe try signing in?");
				error.status = 400;
				return callback(error);
			}

			addUser();
		});
	};

	app.post("/data/signup/now", limits.circle, function (req, res) {
		var data = req.body;
		var proposedAccount = {
			name: data.name,
			email: data.email,
			password: data.password
		};
		var proposedCircle = {
			name: data.circle
		};
		createAccount(proposedAccount, proposedCircle, handle(res));
	});

	app.post("/data/signup/waitlist", function (req, res) {
		var data = req.body;
		var request = {
			circle: data.circle,
			things: data.things,
			email: data.email
		};

		db.waitlist.add(request, handle(res));
	});

	app.get("/data/waitlist", ensure.mainframe, send(db.waitlist.get));

	// The secret to bridging Angular and Express in a 
	// way that allows us to pass any path to the client.
	// 
	// Also, this depends on the static middleware being
	// near the top of the stack.
	app.get('*', function (req, res) {
		// Redirect to 'initialize' on first-time use.
		//
		// Use a cookie to control flow and prevent redirect loops.
		// Maybe not the best idea; feel free to have a better one.
		var usersExist = function(callback) {
			db.users.count(function (err, count) {
				if (err) {
					return callback(err);
				}
				callback(null, count > 0);
			});
		};

		usersExist(guard(res, function (exist) {
			if (!exist && !req.cookies.initializing) {
				res.cookie('initializing', 'yep');
				res.redirect('/#/initialize');
			}
			else {
				res.clearCookie('initializing');
				routes.index(req, res);			
			}
		}));
	});
};

var startServer = function () {
	http.createServer(app).listen(app.get('port'), function () {
		console.log("Express http server listening on port " + app.get('port'));
	});
		
	// Run an https server if we can.
	tryToCreateHttpsServer(function (err, success) {
		if (err) {
			console.log(err);
		}
		else {
			console.log(success);
		}
	});
}

var forceHttps = function(req, res, next) {
	if (!sslServer.isRunning()) {
		// Don't do anything if we can't do anything.
		return next();
	}

	if(req.secure 
		|| req.headers['x-forwarded-proto'] === 'https' 
		|| req.host === "localhost") {
		return next();	
	}
	res.redirect('https://' + req.get('Host') + req.url);
};

var getCookieSettings = function () {
	// TODO: Check settings to guess if https is running.
	// Or actually figure out if https is running, and if so
	// use secure cookies
	var oneHour = 3600000;
	var twoWeeks = 14 * 24 * oneHour;
	var cookieSettings = {
		path: '/',
		httpOnly: true,
		secure: false,
		maxAge: twoWeeks
	};

	return cookieSettings;
};

// configure Express
app.configure(function() {
	app.set('port', process.env.PORT || 3000);
	app.set('ssl-port', process.env.SSL_PORT || 4000);
	app.set('views', __dirname + '/views');
	app.set('view engine', 'ejs');
	app.use(forceHttps);
	app.use(express.compress());
	app.use(express.static(path.join(__dirname, 'public')));
	app.use(express.logger('dev'));
	app.use(express.cookieParser());
	app.use(express.bodyParser());
	app.use(express.methodOverride());

	var initSettingsOk = function (settings) {
		var sessionSecret = settings['session-secret'].value;
		var SessionStore = couchSessionStore(express.session);
		var cookieSettings = getCookieSettings();
		app.use(express.session({ 
			store: new SessionStore(),
			secret: sessionSecret,
			cookie: cookieSettings
		}));

		var stripeApiKey = settings['stripe-secret-key'];
		if (stripeApiKey) {
			payment.setApiKey(stripeApiKey.value);
		}

		// Init authentication
		auth.attach(app);
		// Routes
		app.use(app.router);
		// Catch errors
		app.use(function (err, req, res, next) {
			if (err) {
				return errors.handle(err, res);
			}
			// TODO: Should not get here.
		});
		defineRoutes();
		ready();
	};

	settings.init(function (err, settings) {
		if (err) {
			console.log(err);
		}
		else {
			initSettingsOk(settings);
		}
	});
});

function ready() {
	isReady = true;
	ee.emit('circle-blvd-app-is-ready');
}

exports.whenReady = function (callback) {
	if (isReady) {
		return callback();
	}
	ee.once('circle-blvd-app-is-ready', function () {
		callback();
	});
};

exports.express = app;
exports.startServer = startServer;