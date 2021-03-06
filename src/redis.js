import { isEmpty } from '@mapbox/tilelive/lib/stream-util';

const redis = require('redis');
const fs = require('fs');
const _ = require('underscore');
const zlib = require('zlib');
const xmlStream = require('xml-stream');
require('redis-streams')(redis);
const multiStream = require('multistream');
var proj4 = require('proj4');
var inputProj = proj4('+proj=utm +zone=54 +south +ellps=WGS84 +datum=WGS84 +units=m +no_defs');
var outputProj = proj4('EPSG:4326');

var redisClient = null

var all_activities = {};
var networkNodes = {};
var networkLinks = {};
var timeStampedEvents = {};
var agents_startingPos = {};

export function connectRedisClient() {
    redisClient = redis.createClient();

    redisClient.on('connect', function () {
        console.log('Redis client connected!');
    });
}

// Filter xml population file to set and add them to redis
export function loadPopulation() {
    // delete all sets
    redisClient.keys('*', function (err, keys) {
        if (err)
            console.log(err);
        else {
            keys.filter(function (key) {
                deleteSet(key);
            });
        }
    });

    var xml = null;
    try {
        // Create stream from population gzip file
        var readStream = fs.createReadStream('../../ees/scenarios/surf-coast-shire/typical-summer-weekday-50k/scenario_matsim_plans.xml.gz')
            .pipe(zlib.createGunzip());

        readStream.on('error', function (err) {
            console.log('Error loading population xml: ', err);
        });

        // Create xml stream and only retain activity tags
        xml = new xmlStream(readStream);
        xml.collect('activity');
        xml.on('endElement: activity', function (activity) {
            processActivities(activity);
        });

        // After xml stream ends add activity sets to redis
        xml.on('end', function () {
            // go through all keys in the map and add values to redis
            Object.keys(all_activities).filter(function (key) {
                setValues(key, all_activities[key][key]);

                // delete object so we wouldn't keep holding it in memory
                delete all_activities[key];

            });
        });

    } catch (e) {
        console.log('Error loading population xml: ', e.stack);
    }
}

export function getPopulationMultiStream(keys) {
    var activityStreamsArr = [];

    // Collects an array of streams of requeseted activities 
    keys.filter(function (key) {
        activityStreamsArr.push(redisClient.readStream(key))
    });

    // runs array of multiple streams in sequence
    var activityStreams = multiStream(activityStreamsArr);

    activityStreams.on('end', function () {
        console.log('multistream ended');
    });

    activityStreams.on('error', function () {
        console.log('error reading multple streams array');
    });

    return activityStreams;
}

export function getPopulationStream(key) {
    var redisStream = redisClient.readStream(key);

    redisStream.on('end', function () {
        console.log('redis population stream ended');
    });

    redisStream.on('error', function () {
        console.log('error reading multple streams array');
    });

    return redisStream;
}

export function getAgentsStartingPos() {
    var agentsStartingPos = redisClient.readStream('agents_startingPos');

    agentsStartingPos.on('end', function () {
        console.log('agents_startingPos stream ended');
    });

    agentsStartingPos.on('error', function () {
        console.log('error reading agents_startingPos stream');
    });

    return agentsStartingPos;
}

export function getAgentsEvents(eventGroup) {

    var agentsEvents = redisClient.readStream(eventGroup);


    agentsEvents.on('end', function () {
        console.log('agents_events stream ended');
    });

    agentsEvents.on('error', function () {
        console.log('error reading agents_events stream');
    });

    return agentsEvents;
}

export function getPopulationSets({ keys }) {
    return new Promise(function (resolve, reject) {
        redisClient.multi()
            .get(keys[0])
            .get(keys[1])
            .get(keys[2])
            .get(keys[3])
            .get(keys[4])
            .get(keys[5])
            .exec(function (err, reply) {
                if (err)
                    reject(err);
                else
                    resolve(reply);
            });
    });
}

// Add elements to activity redis lists
function pushToRedisList(activity) {
    _.filter(activity,
        function (innerActivityObject) {
            var activityJson = JSON.stringify(innerActivityObject);
            var name = 'activities_' + innerActivityObject.type;
            redisClient.rpush(name, activityJson, function (err, reply) {
                if (err)
                    console.log('Error adding ' + activity + ': ', err);
            });
        });
}

function deleteSet(key) {
    redisClient.del(key, function (err, reply) {
        if (err)
            console.log(err)
        else
            console.log(key + ' deleted');
    });
}

// Add a set to redis
function setValues(key, set) {
    var setJson = JSON.stringify(set);
    redisClient.set(key, setJson, function (err, reply) {
        if (reply)
            console.log(key + ': ', reply);
        if (err)
            console.log('Error adding ' + key + ': ', err);
    });
}

// Generates lists on the fly given the activities stream
function processActivities(activity) {
    _.filter(activity,
        function (innerActivityObject) {
            // generate list key
            var key = 'activities_' + innerActivityObject.type;
            // if key does not exist, create a map on the fly using the key with an empty list value
            if (!all_activities[key]) {
                all_activities[key] = { [key]: [] };
            }

            var feature =
            {
                "type": "Feature",
                "properties": {
                    "activity": innerActivityObject.type
                },
                "geometry": {
                    "type": "Point",
                    "coordinates":
                        proj4(inputProj, outputProj, [parseInt(innerActivityObject.x), parseInt(innerActivityObject.y)]),
                }
            };

            // push element to key's list
            all_activities[key][key].push(feature);
        });
}

//creates lookup table for links
export function getOutputNetwork() {

    var xml = null;
    try {
        // Create stream from population gzip file
        var readStream = fs.createReadStream('../../ees/test/output/io/github/agentsoz/ees/TypicalSummerWeekday50kTest/testTypicalSummerWeekday50k/matsim/output_network.xml.gz')
            .pipe(zlib.createGunzip());

        readStream.on('error', function (err) {
            console.log('Error loading population xml: ', err);
        });

        // Create xml stream and only retain activity tags
        xml = new xmlStream(readStream);
        xml.collect('node');
        xml.on('endElement: node', function (node) {
            _.filter(node, function (innerNode) {
                networkNodes[innerNode.id] = [parseInt(innerNode.x), parseInt(innerNode.y)];
            });
        });

        xml.on('end', function () {
            getOutputNetworkLinks();
        });

    } catch (e) {
        console.log('Error reading xml: ', e.stack);
    }
}

function getOutputNetworkLinks() {
    var xml = null;
    try {
        // Create stream from population gzip file
        var readStream = fs.createReadStream('../../ees/test/output/io/github/agentsoz/ees/TypicalSummerWeekday50kTest/testTypicalSummerWeekday50k/matsim/output_network.xml.gz')
            .pipe(zlib.createGunzip());

        readStream.on('error', function (err) {
            console.log('Error loading population xml: ', err);
        });

        // Create xml stream and only retain activity tags
        xml = new xmlStream(readStream);
        xml.collect('link');
        xml.on('endElement: link', function (link) {
            _.filter(link, function (innerLink) {

                //convert long and lat from EPSG:4326 to EPSG:28355 
                networkLinks[innerLink.id] = [
                    proj4(inputProj, outputProj, networkNodes[innerLink.from]),
                    proj4(inputProj, outputProj, networkNodes[innerLink.to])
                ];
            });
        });

        xml.on('end', function () {
            getOutputEvents();
        });

    } catch (e) {
        console.log('Error reading xml: ', e.stack);
    }
}

function getOutputEvents() {
    var xml = null;
    try {
        // Create stream from population gzip file
        var readStream = fs.createReadStream('../../ees/test/output/io/github/agentsoz/ees/TypicalSummerWeekday500Test/testTypicalSummerWeekday500/matsim/output_events.xml.gz')
            .pipe(zlib.createGunzip());

        readStream.on('error', function (err) {
            console.log('Error loading population xml: ', err);
        });

        // Create xml stream and only retain activity tags
        xml = new xmlStream(readStream);
        xml.collect('event');
        var eventTime = 0;
        var eventTimeInterval = 0;
        var person = {};
        var i = 1;

        xml.on('endElement: event', function (event) {
            _.filter(event, function (innerEvent) {

                if (innerEvent.type == "left link") {
                    if (innerEvent.time != eventTime &&
                        !_.isEmpty(person)) {

                        if ((innerEvent.time - eventTimeInterval >= 300)) {

                            // Since we're storing events as a group for each ten minutes,
                            // this would help us to keep track of when each ten minutes has passed.
                            eventTimeInterval = innerEvent.time;

                            // Save list to redis
                            setValues('agents_events_' + i, JSON.stringify(timeStampedEvents));

                            //reset map
                            timeStampedEvents = {};

                            i++;
                        }

                        timeStampedEvents[eventTime] = person;

                        // Reset person map each time we reach a new time stamp
                        person = {};
                    }

                    /* Gather a map of persons and the event they're taking at a certain timestamp.
                    An event is basically a destination (the lat and long) to which the person will
                    travel to at acertain time stamp.
                    */
                    person[innerEvent.vehicle] = networkLinks[innerEvent.link];
                    eventTime = innerEvent.time;

                    if (agents_startingPos[innerEvent.vehicle] == null)
                        agents_startingPos[innerEvent.vehicle] = networkLinks[innerEvent.link][0];
                }
            });
        });


        xml.on('end', function () {
            //setValues('agents_events', JSON.stringify(timeStampedEvents));
            setValues('agents_startingPos', JSON.stringify(agents_startingPos));

            /* UNCOMMENT THIS BLOCK TO GENERATE AGENT DATA FILES*/

            // fs.writeFile('C:/Users/Mohamad/Desktop/Other stuff/Uni/Sem 1 2019/FYP/ees-ui/agents_startingPos.js',
            // 'export var agents_startingPos =\n' +
            // JSON.stringify(agents_startingPos) + ';', function (err) {
            //     if (err)
            //         console.log(err);

            //         console.log("agents_startingPos.js was saved!");
            // });
        });

        xml.on('error', function (err) {
            console.log('Error loading population xml: ', err);
        });

    } catch (e) {
        console.log('Error reading xml: ', e.stack);
    }
}