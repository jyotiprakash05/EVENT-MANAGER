(function () {
    const config = window.EVENTPRO_AWS_CONFIG;
    const sdk = window.AmazonCognitoIdentity;

    if (!config || !sdk) return;

    const pool = new sdk.CognitoUserPool({
        UserPoolId: config.userPoolId,
        ClientId: config.clientId
    });
    
    let docClient = null;
    let s3Client = null;
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
                s3Client = new AWS.S3({ apiVersion: '2006-03-01' });
                callback(null);
            });
        });
    }

    window.OrganizerBackend = {
        uploadImage: function(file, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const fileExt = file.name.split('.').pop();
                const fileName = `events/${currentUserSub}/${Date.now()}.${fileExt}`;
                
                const params = {
                    Bucket: config.s3BucketName,
                    Key: fileName,
                    Body: file,
                    ContentType: file.type
                };
                
                s3Client.upload(params, function(err, data) {
                    if (err) {
                        console.error("S3 Upload Error:", err);
                        return callback(err);
                    }
                    callback(null, data.Location);
                });
            });
        },

        saveEvent: function(eventData, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                window.OrganizerBackend.getUserProfile((profileErr, profile) => {
                    let orgName = "Unknown Organizer";
                    let orgBio = "No bio available.";
                    
                    if (!profileErr && profile) {
                        if (profile.firstName && profile.lastName) {
                            orgName = (profile.firstName + " " + profile.lastName).trim();
                        } else if (profile.firstName) {
                            orgName = profile.firstName;
                        }
                        if (profile.bio) orgBio = profile.bio;
                    }
                    
                    const eventId = eventData.eventId || ("EVT-" + Date.now() + "-" + Math.floor(Math.random() * 1000));
                    const params = {
                        TableName: config.eventsTableName,
                        Item: {
                            eventId: eventId,
                            organizerId: currentUserSub,
                            organizerName: orgName,
                            organizerBio: orgBio,
                            eventName: eventData.eventName,
                            date: eventData.date,
                            time: eventData.time,
                            location: eventData.location,
                            googleMapLink: eventData.googleMapLink || "",
                            salesDeadline: eventData.salesDeadline || "",
                            capacity: eventData.capacity,
                            price: eventData.price,
                            description: eventData.description,
                            imageUrl: eventData.imageUrl || "",
                            status: eventData.status || "Active",
                            ticketsSold: eventData.ticketsSold || 0,
                            revenue: eventData.revenue || 0,
                            createdAt: eventData.createdAt || new Date().toISOString()
                        }
                    };
                    
                    docClient.put(params, function(err, data) {
                        if (err) callback(err);
                        else callback(null, params.Item);
                    });
                });
            });
        },
        
        getEvent: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.eventsTableName,
                    Key: { eventId: eventId }
                };
                
                docClient.get(params, function(err, data) {
                    if (err) callback(err);
                    else if (!data.Item) callback(new Error("Event not found"));
                    else callback(null, data.Item);
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
        
        checkInTicket: function(ticketId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                // First verify the ticket
                this.verifyTicket(ticketId, (err, ticket) => {
                    if (err) return callback(err);
                    
                    if (ticket.status === 'Used') {
                        return callback(null, { success: false, message: 'Ticket already used', ticket: ticket });
                    }
                    
                    // 1. Update ticket status to Used
                    const updateParams = {
                        TableName: config.ticketsTableName,
                        Key: { ticketId: ticketId },
                        UpdateExpression: "set #s = :status",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: { ":status": "Used" }
                    };
                    
                    docClient.update(updateParams, (updateErr) => {
                        if (updateErr) return callback(updateErr);
                        
                        // 2. Log check-in
                        const checkinParams = {
                            TableName: config.checkinsTableName,
                            Item: {
                                checkinId: "CHK-" + Date.now(),
                                ticketId: ticketId,
                                eventId: ticket.eventId || "UNKNOWN",
                                scannedBy: currentUserSub,
                                timestamp: new Date().toISOString()
                            }
                        };
                        
                        docClient.put(checkinParams, (checkinErr) => {
                            if (checkinErr) console.error("Failed to log checkin", checkinErr);
                            // We still return success because the ticket was marked used
                            callback(null, { success: true, message: 'Ticket verified and checked in!', ticket: ticket });
                        });
                    });
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
        
        recordPayment: function(paymentDetails, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.paymentsTableName,
                    Item: {
                        paymentId: paymentDetails.paymentId || "PAY-" + Date.now(),
                        userId: currentUserSub,
                        amount: paymentDetails.amount,
                        currency: paymentDetails.currency || "USD",
                        planDays: paymentDetails.planDays,
                        status: paymentDetails.status || "Completed",
                        timestamp: new Date().toISOString()
                    }
                };
                
                docClient.put(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, params.Item);
                });
            });
        },
        
        activateSubscription: function(days, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const expiryDate = new Date();
                expiryDate.setDate(expiryDate.getDate() + days);
                
                const params = {
                    TableName: config.dynamoDBTableName,
                    Key: { userId: currentUserSub },
                    UpdateExpression: "set subscriptionActive = :active, subscriptionExpiry = :expiry",
                    ExpressionAttributeValues: {
                        ":active": true,
                        ":expiry": expiryDate.toISOString()
                    }
                };
                
                docClient.update(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data);
                });
            });
        },
        
        updateUserProfile: function(userData, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.dynamoDBTableName,
                    Key: { userId: currentUserSub },
                    UpdateExpression: "set firstName = :f, lastName = :l, email = :e, bio = :b",
                    ExpressionAttributeValues: {
                        ":f": userData.firstName,
                        ":l": userData.lastName,
                        ":e": userData.email,
                        ":b": userData.bio || ""
                    }
                };
                
                docClient.update(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data);
                });
            });
        },
        
        deleteEvent: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                const params = {
                    TableName: config.eventsTableName,
                    Key: { eventId: eventId }
                };
                
                docClient.delete(params, function(err, data) {
                    if (err) callback(err);
                    else callback(null, data);
                });
            });
        },
        
        requestWithdrawal: function(amount, details, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                
                window.OrganizerBackend.getUserProfile((err, profile) => {
                    if (err) return callback(err);
                    
                    const currentWithdrawn = profile.withdrawnAmount || 0;
                    const newWithdrawn = currentWithdrawn + amount;
                    
                    const updateParams = {
                        TableName: config.dynamoDBTableName,
                        Key: { userId: currentUserSub },
                        UpdateExpression: "set withdrawnAmount = :w, withdrawalDetails = :d",
                        ExpressionAttributeValues: {
                            ":w": newWithdrawn,
                            ":d": details
                        }
                    };
                    
                    docClient.update(updateParams, function(updateErr) {
                        if (updateErr) callback(updateErr);
                        else callback(null);
                    });
                });
            });
        }
    };
})();
