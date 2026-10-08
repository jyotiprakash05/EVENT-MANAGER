(function () {
    const config = window.EVENTPRO_AWS_CONFIG;
    const sdk = window.AmazonCognitoIdentity;

    if (!config || !sdk) return;

    const pool = new sdk.CognitoUserPool({
        UserPoolId: config.userPoolId,
        ClientId: config.clientId
    });
    
    let docClient = null;
    let currentUserSub = null;
    
    function initAWS(callback) {
        if (docClient) {
            callback(null);
            return;
        }

        const user = pool.getCurrentUser();
        if (!user) {
            callback(new Error("No user logged in"));
            return;
        }

        user.getSession(function (error, session) {
            if (error) {
                callback(error);
                return;
            }

            const idToken = session.getIdToken().getJwtToken();
            currentUserSub = session.getIdToken().payload.sub;
            
            const logins = {};
            logins[`cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`] = idToken;
            
            AWS.config.region = config.region;
            AWS.config.credentials = new AWS.CognitoIdentityCredentials({
                IdentityPoolId: config.identityPoolId,
                Logins: logins
            });

            AWS.config.credentials.get(function(err) {
                if (err) {
                    callback(err);
                    return;
                }
                docClient = new AWS.DynamoDB.DocumentClient();
                callback(null);
            });
        });
    }

    window.AttendeeBackend = {
        getAllEvents: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.eventsTableName
                };
                
                docClient.scan(params, function(err, data) {
                    if (err) callback(err);
                    else {
                        const activeEvents = data.Items.filter(e => e.status !== 'Draft');
                        callback(null, activeEvents);
                    }
                });
            });
        },
        
        bookTicket: function(event, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const ticketId = "TKT-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
                
                const ticketParams = {
                    TableName: config.ticketsTableName,
                    Item: {
                        ticketId: ticketId,
                        eventId: event.eventId,
                        eventName: event.eventName || "Unnamed Event",
                        attendeeId: currentUserSub,
                        status: "Valid",
                        date: event.date || "TBD",
                        time: event.time || "TBD",
                        location: event.location || "TBA",
                        purchasedAt: new Date().toISOString()
                    }
                };
                
                docClient.put(ticketParams, function(putErr) {
                    if (putErr) {
                        console.error("Failed to save ticket", putErr);
                        callback(putErr);
                        return;
                    }
                    
                    const updateEventParams = {
                        TableName: config.eventsTableName,
                        Key: { eventId: event.eventId },
                        UpdateExpression: "set ticketsSold = if_not_exists(ticketsSold, :start) + :inc, revenue = if_not_exists(revenue, :startRev) + :price",
                        ConditionExpression: "attribute_exists(eventId)",
                        ExpressionAttributeValues: {
                            ":inc": 1,
                            ":start": 0,
                            ":price": event.price || 0,
                            ":startRev": 0
                        }
                    };
                    
                    docClient.update(updateEventParams, function(updateErr) {
                        if (updateErr) {
                            console.error("Could not update ticketsSold for event", updateErr);
                            if (updateErr.code === 'ConditionalCheckFailedException') {
                                // Event was deleted, but ticket was already saved.
                                // We'll still return the ticket to not break the UI.
                            }
                        }
                        
                        if (window.emailjs) {
                            window.AttendeeBackend.getUserProfile((profileErr, profile) => {
                                const userEmail = (!profileErr && profile && profile.email) ? profile.email : "attendee@example.com";
                                const userName = (!profileErr && profile && profile.firstName) ? profile.firstName : "Attendee";
                                
                                const qrPayload = `Ticket ID: ${ticketId}\nEvent: ${event.eventName || "Unnamed Event"}\nDate: ${event.date || "TBD"} at ${event.time || "TBD"}\nVenue: ${event.location || "TBA"}\nAttendee: ${userName}`;

                                const templateParams = {
                                    to_email: userEmail,
                                    to_name: userName,
                                    event_title: event.eventName || "Unnamed Event",
                                    event_date: event.date || "TBD",
                                    event_venue: event.location || "TBA",
                                    ticket_id: ticketId,
                                    order_id: ticketId,
                                    // Use quickchart or put data first so that if & is escaped to &amp; by EmailJS, the QR code still generates
                                    qr_url: `https://quickchart.io/qr?text=${encodeURIComponent(qrPayload)}&size=200`
                                };
                                
                                emailjs.send('service_w5mpz2s', 'template_cqxegxr', templateParams)
                                    .then(function(response) {
                                        console.log('Email sent!', response.status, response.text);
                                    }, function(error) {
                                        console.log('Failed to send email...', error);
                                    });
                            });
                        }
                        
                        callback(null, ticketParams.Item);
                    });
                });
            });
        },
        
        getMyBookings: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.ticketsTableName
                };
                
                docClient.scan(params, function(err, data) {
                    if (err) callback(err);
                    else {
                        const myTickets = data.Items.filter(t => t.attendeeId === currentUserSub);
                        callback(null, myTickets);
                    }
                });
            });
        },

        cancelBooking: function(ticketId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.ticketsTableName,
                    Key: { ticketId: ticketId },
                    UpdateExpression: "set #s = :status",
                    ExpressionAttributeNames: { "#s": "status" },
                    ExpressionAttributeValues: { ":status": "Cancelled" }
                };
                
                docClient.update(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data);
                });
            });
        },
        
        getUserProfile: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.dynamoDBTableName,
                    Key: { userId: currentUserSub }
                };
                
                docClient.get(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data.Item || {});
                });
            });
        },
        
        updateUserProfile: function(userData, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.dynamoDBTableName,
                    Key: { userId: currentUserSub },
                    UpdateExpression: "set firstName = :f, lastName = :l, email = :e",
                    ExpressionAttributeValues: {
                        ":f": userData.firstName,
                        ":l": userData.lastName,
                        ":e": userData.email
                    }
                };
                
                docClient.update(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data);
                });
            });
        },

        toggleSavedEvent: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                // Fetch current user profile to get saved events array
                window.AttendeeBackend.getUserProfile((err, profile) => {
                    if (err) return callback(err);

                    let savedEvents = profile.savedEvents || [];
                    const index = savedEvents.indexOf(eventId);
                    let isSaved = false;

                    if (index > -1) {
                        savedEvents.splice(index, 1);
                    } else {
                        savedEvents.push(eventId);
                        isSaved = true;
                    }

                    const params = {
                        TableName: config.dynamoDBTableName,
                        Key: { userId: currentUserSub },
                        UpdateExpression: "set savedEvents = :s",
                        ExpressionAttributeValues: {
                            ":s": savedEvents
                        }
                    };
                    
                    docClient.update(params, function(err) {
                        if (err) callback(err);
                        else callback(null, { isSaved, savedEvents });
                    });
                });
            });
        },

        joinWaitlist: function(event, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                const waitlistTicket = {
                    ticketId: "WTL-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
                    eventId: event.eventId,
                    eventName: event.eventName,
                    date: event.date,
                    time: event.time,
                    location: event.location,
                    userId: currentUserSub,
                    status: "Waitlisted",
                    purchaseDate: new Date().toISOString()
                };

                const params = {
                    TableName: config.ticketsTableName,
                    Item: waitlistTicket
                };

                docClient.put(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, waitlistTicket);
                });
            });
        },

        submitReview: function(eventId, rating, comment, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                window.AttendeeBackend.getUserProfile((profileErr, profile) => {
                    const userName = (!profileErr && profile) ? (profile.firstName + " " + profile.lastName) : "Anonymous Attendee";
                    
                    const params = {
                        TableName: config.reviewsTableName,
                        Item: {
                            reviewId: "REV-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
                            eventId: eventId,
                            userId: currentUserSub,
                            userName: userName,
                            rating: rating,
                            comment: comment,
                            timestamp: new Date().toISOString()
                        }
                    };
                    
                    docClient.put(params, function(err, data) {
                        if (err) callback(err);
                        else callback(null, params.Item);
                    });
                });
            });
        },

        getEventReviews: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.reviewsTableName,
                    FilterExpression: "eventId = :eid",
                    ExpressionAttributeValues: {
                        ":eid": eventId
                    }
                };
                
                docClient.scan(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data.Items);
                });
            });
        }
    };
})();
