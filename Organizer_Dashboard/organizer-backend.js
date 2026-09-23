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

    window.OrganizerBackend = {
        saveEvent: function(eventData, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const eventId = "EVT-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
                const params = {
                    TableName: config.eventsTableName,
                    Item: {
                        eventId: eventId,
                        organizerId: currentUserSub,
                        eventName: eventData.eventName,
                        date: eventData.date,
                        time: eventData.time,
                        location: eventData.location,
                        googleMapLink: eventData.googleMapLink || "",
                        salesDeadline: eventData.salesDeadline || "",
                        capacity: eventData.capacity,
                        price: eventData.price,
                        description: eventData.description,
                        status: "Active",
                        ticketsSold: 0,
                        revenue: 0,
                        createdAt: new Date().toISOString()
                    }
                };
                
                docClient.put(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, params.Item);
                });
            });
        },
        
        getEvents: function(callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.eventsTableName
                };
                
                // Using scan here for simplicity, in production you'd use query with a GSI on organizerId
                docClient.scan(params, function(err, data) {
                    if (err) callback(err);
                    else {
                        const myEvents = data.Items.filter(e => e.organizerId === currentUserSub);
                        callback(null, myEvents);
                    }
                });
            });
        },
        
        verifyTicket: function(ticketId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.ticketsTableName,
                    Key: { ticketId: ticketId }
                };
                
                docClient.get(params, function(err, data) {
                    if (err) callback(err);
                    else if (!data.Item) callback(new Error("Ticket not found"));
                    else callback(null, data.Item);
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
                    else callback(null, data.Item);
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
        }
    };
})();
