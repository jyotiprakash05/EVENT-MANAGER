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
                        eventName: event.eventName,
                        attendeeId: currentUserSub,
                        status: "Valid",
                        date: event.date,
                        time: event.time,
                        location: event.location,
                        purchasedAt: new Date().toISOString()
                    }
                };
                
                docClient.put(ticketParams, function(err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    
                    // Increment ticketsSold in the event
                    const updateEventParams = {
                        TableName: config.eventsTableName,
                        Key: { eventId: event.eventId },
                        UpdateExpression: "set ticketsSold = if_not_exists(ticketsSold, :start) + :inc",
                        ExpressionAttributeValues: {
                            ":inc": 1,
                            ":start": 0
                        }
                    };
                    
                    docClient.update(updateEventParams, function(updateErr) {
                        if (updateErr) console.error("Could not update ticketsSold for event", updateErr);
                        
                        // Send EmailJS Email (Needs configuration)
                        // Make sure you include the EmailJS SDK in the HTML!
                        if (window.emailjs) {
                            const templateParams = {
                                to_email: "attendee@example.com", // In a real app, use the actual user's email from their profile
                                event_name: event.eventName,
                                ticket_id: ticketId,
                                date: event.date,
                                location: event.location,
                                qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${ticketId}`
                            };
                            
                            // NOTE: Replace 'YOUR_SERVICE_ID' and 'YOUR_TEMPLATE_ID' with actual EmailJS details
                            emailjs.send('YOUR_SERVICE_ID', 'YOUR_TEMPLATE_ID', templateParams)
                                .then(function(response) {
                                    console.log('Email sent!', response.status, response.text);
                                }, function(error) {
                                    console.log('Failed to send email...', error);
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
                
                // Using scan here. In production, use query with a GSI on attendeeId
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
        }
    };
})();
