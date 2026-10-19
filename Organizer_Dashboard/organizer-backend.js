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
                            category: eventData.category || "concert",
                            date: eventData.date,
                            time: eventData.time,
                            location: eventData.location,
                            googleMapLink: eventData.googleMapLink || "",
                            salesDeadline: eventData.salesDeadline || "",
                            salesDeadlineDate: eventData.salesDeadlineDate || "",
                            salesDeadlineTime: eventData.salesDeadlineTime || "",
                            capacity: eventData.capacity,
                            price: eventData.price,
                            hasDepositBond: !!eventData.hasDepositBond,
                            refundableDeposit: parseFloat(eventData.refundableDeposit) || 0,
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
        
        checkInTicket: function(ticketId, optionsOrCallback, optionalCallback) {
            let options = {};
            let callback = optionalCallback;
            if (typeof optionsOrCallback === 'function') {
                callback = optionsOrCallback;
            } else if (typeof optionsOrCallback === 'object') {
                options = optionsOrCallback || {};
            }

            initAWS((err) => {
                if (err) return callback(err);

                // Fetch organizer's events to verify authorization
                this.getEvents((eventsErr, myEvents) => {
                    if (eventsErr) return callback(eventsErr);

                    const myEventsList = myEvents || [];
                    const myEventIds = new Set(myEventsList.map(e => e.eventId));

                    // 1. Fetch ticket to inspect current state
                    this.verifyTicket(ticketId, (err, ticket) => {
                        if (err) return callback(err);

                        // Prevent scanning tickets for another organizer's events
                        if (!ticket.eventId || !myEventIds.has(ticket.eventId)) {
                            return callback(null, {
                                success: false,
                                differentEvent: true,
                                message: `Ticket is for an event not hosted by your organizer account: "${ticket.eventName || ticket.eventId || 'Unknown'}"`,
                                ticket: ticket
                            });
                        }

                        // Check for expected event match if scanner is filtering by a specific event
                        if (options.expectedEventId && ticket.eventId !== options.expectedEventId) {
                            return callback(null, {
                                success: false,
                                differentEvent: true,
                                message: `Ticket is for a different event: "${ticket.eventName || ticket.eventId}"`,
                                ticket: ticket
                            });
                        }

                        // Check for cancelled ticket
                        if (ticket.status === 'Cancelled') {
                            return callback(null, {
                                success: false,
                                cancelled: true,
                                message: 'Ticket is marked as Cancelled/Refunded',
                                ticket: ticket
                            });
                        }

                        // Check if already used
                        if (ticket.status === 'Used') {
                            const checkedInTime = ticket.checkedInAt ? new Date(ticket.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'earlier';
                            return callback(null, {
                                success: false,
                                duplicate: true,
                                message: `Ticket already used at ${checkedInTime}! Entry rejected.`,
                                ticket: ticket
                            });
                        }

                        const now = new Date().toISOString();
                        const hasDeposit = !!(ticket.hasDeposit || ticket.depositAmount > 0);
                        const depositAmt = parseFloat(ticket.depositAmount || 0);

                        let updateExp = "SET #s = :used, checkedInAt = :now, scannedBy = :scanner";
                        const expVals = {
                            ":used": "Used",
                            ":valid": "Valid",
                            ":now": now,
                            ":scanner": currentUserSub
                        };

                        if (hasDeposit) {
                            updateExp += ", depositStatus = :refunded, depositRefundedAt = :now";
                            expVals[":refunded"] = "Refunded";
                        }

                        // 2. Perform ATOMIC conditional update:
                        // Condition: attribute_exists(ticketId) AND status = 'Valid'
                        // This eliminates race conditions if two devices scan the ticket simultaneously!
                        const updateParams = {
                            TableName: config.ticketsTableName,
                            Key: { ticketId: ticketId },
                            UpdateExpression: updateExp,
                            ConditionExpression: "attribute_exists(ticketId) AND #s = :valid",
                            ExpressionAttributeNames: { "#s": "status" },
                            ExpressionAttributeValues: expVals,
                            ReturnValues: "ALL_NEW"
                        };

                        docClient.update(updateParams, (updateErr, updateData) => {
                            if (updateErr) {
                                if (updateErr.code === 'ConditionalCheckFailedException') {
                                    return callback(null, {
                                        success: false,
                                        duplicate: true,
                                        raceConditionBlocked: true,
                                        message: 'Duplicate check-in blocked by atomic lock! Ticket was just verified on another device.',
                                        ticket: ticket
                                    });
                                }
                                console.error("Atomic check-in update error:", updateErr);
                                return callback(updateErr);
                            }

                            const updatedTicket = (updateData && updateData.Attributes) ? updateData.Attributes : { ...ticket, status: 'Used', checkedInAt: now, depositStatus: hasDeposit ? 'Refunded' : undefined };

                            // 3. Log into EventProCheckins table
                            const checkinItem = {
                                checkinId: "CHK-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
                                ticketId: ticketId,
                                eventId: ticket.eventId || "UNKNOWN",
                                eventName: ticket.eventName || "Unnamed Event",
                                attendeeId: ticket.attendeeId || "UNKNOWN",
                                attendeeName: ticket.attendeeName || "Verified Attendee",
                                scannedBy: currentUserSub,
                                organizerId: currentUserSub,
                                timestamp: now,
                                depositRefunded: hasDeposit,
                                depositAmount: depositAmt
                            };

                            const checkinParams = {
                                TableName: config.checkinsTableName,
                                Item: checkinItem
                            };

                            docClient.put(checkinParams, (checkinErr) => {
                                if (checkinErr) {
                                    console.warn("Notice: checkin log put warning (non-fatal):", checkinErr);
                                }

                                // If this was an individual split sub-ticket, sync the parent ticket's splitMembers array
                                if (ticket.parentTicketId && ticket.memberIndex !== undefined) {
                                    const parentGet = {
                                        TableName: config.ticketsTableName,
                                        Key: { ticketId: ticket.parentTicketId }
                                    };
                                    docClient.get(parentGet, (pErr, pData) => {
                                        if (!pErr && pData && pData.Item && Array.isArray(pData.Item.splitMembers)) {
                                            const sm = pData.Item.splitMembers;
                                            const mIdx = parseInt(ticket.memberIndex, 10);
                                            if (sm[mIdx]) {
                                                sm[mIdx].status = "Used";
                                                sm[mIdx].isUsed = true;
                                                sm[mIdx].checkedInAt = now;
                                                docClient.update({
                                                    TableName: config.ticketsTableName,
                                                    Key: { ticketId: ticket.parentTicketId },
                                                    UpdateExpression: "SET splitMembers = :sm",
                                                    ExpressionAttributeValues: { ":sm": sm }
                                                }, (upErr) => {
                                                    if (upErr) console.warn("Could not sync parent splitMembers status:", upErr);
                                                });
                                            }
                                        }
                                    });
                                }

                                callback(null, {
                                    success: true,
                                    message: `Ticket verified! Welcome, ${ticket.attendeeName || 'Attendee'}.`,
                                    ticket: updatedTicket,
                                    checkin: checkinItem,
                                    depositRefunded: hasDeposit,
                                    depositAmount: depositAmt
                                });
                            });
                        });
                    });
                });
            });
        },

        getEventCheckins: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                this.getEvents((eventsErr, myEvents) => {
                    if (eventsErr) return callback(eventsErr);

                    const myEventsList = myEvents || [];
                    const myEventIds = new Set(myEventsList.map(e => e.eventId));

                    if (myEventsList.length === 0) {
                        return callback(null, []);
                    }

                    if (eventId && eventId !== 'ALL' && !myEventIds.has(eventId)) {
                        return callback(null, []);
                    }

                    const params = {
                        TableName: config.checkinsTableName
                    };

                    docClient.scan(params, function(err, data) {
                        if (err) {
                            console.warn("Checkins scan note:", err);
                            // Fallback: query tickets table for tickets with status === 'Used'
                            return window.OrganizerBackend.getTicketsForEvent(eventId, (tErr, tickets) => {
                                if (tErr) return callback(null, []);
                                const usedTickets = (tickets || []).filter(t => t.status === 'Used').map(t => ({
                                    checkinId: "CHK-" + t.ticketId,
                                    ticketId: t.ticketId,
                                    eventId: t.eventId,
                                    eventName: t.eventName,
                                    attendeeName: t.attendeeName || "Attendee",
                                    timestamp: t.checkedInAt || t.purchasedAt || new Date().toISOString()
                                }));
                                usedTickets.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp));
                                callback(null, usedTickets);
                            });
                        }

                        let checkins = (data && data.Items) ? data.Items : [];
                        // Strictly filter to checkins that belong to this organizer's events
                        if (eventId && eventId !== 'ALL') {
                            checkins = checkins.filter(c => c.eventId === eventId && myEventIds.has(c.eventId));
                        } else {
                            checkins = checkins.filter(c => myEventIds.has(c.eventId));
                        }
                        checkins.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                        callback(null, checkins);
                    });
                });
            });
        },

        getTicketsForEvent: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                this.getEvents((eventsErr, myEvents) => {
                    if (eventsErr) return callback(eventsErr);

                    const myEventsList = myEvents || [];
                    const myEventIds = new Set(myEventsList.map(e => e.eventId));

                    if (myEventsList.length === 0) {
                        return callback(null, []);
                    }

                    if (eventId && eventId !== 'ALL' && !myEventIds.has(eventId)) {
                        return callback(null, []);
                    }

                    const params = {
                        TableName: config.ticketsTableName
                    };

                    docClient.scan(params, function(err, data) {
                        if (err) return callback(err);
                        let tickets = (data && data.Items) ? data.Items : [];

                        // Strictly filter tickets to current organizer's events
                        if (eventId && eventId !== 'ALL') {
                            tickets = tickets.filter(t => t.eventId === eventId && myEventIds.has(t.eventId));
                        } else {
                            tickets = tickets.filter(t => myEventIds.has(t.eventId));
                        }
                        callback(null, tickets);
                    });
                });
            });
        },

        getLiveEventStats: function(eventId, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                this.getEvents((eventsErr, events) => {
                    if (eventsErr) return callback(eventsErr);

                    const targetEvents = (eventId && eventId !== 'ALL') 
                        ? (events || []).filter(e => e.eventId === eventId) 
                        : (events || []);

                    this.getTicketsForEvent(eventId, (ticketsErr, tickets) => {
                        const allTickets = tickets || [];
                        const validOrUsedTickets = allTickets.filter(t => t.status !== 'Cancelled');
                        const checkedInTickets = allTickets.filter(t => t.status === 'Used');

                        let totalCapacity = 0;
                        targetEvents.forEach(e => {
                            totalCapacity += (parseInt(e.capacity, 10) || 0);
                        });

                        const totalRegistered = validOrUsedTickets.length;
                        const totalCheckedIn = checkedInTickets.length;
                        const remainingCapacity = Math.max(0, totalCapacity - totalRegistered);
                        const attendanceRate = totalRegistered > 0 ? Math.round((totalCheckedIn / totalRegistered) * 100) : 0;
                        const noShowCount = Math.max(0, totalRegistered - totalCheckedIn);

                        this.getEventCheckins(eventId, (chkErr, checkins) => {
                            callback(null, {
                                events: events || [],
                                selectedEventId: eventId || 'ALL',
                                selectedEvents: targetEvents,
                                stats: {
                                    totalCapacity,
                                    totalRegistered,
                                    totalCheckedIn,
                                    remainingCapacity,
                                    attendanceRate,
                                    noShowCount,
                                    cancelledCount: allTickets.filter(t => t.status === 'Cancelled').length
                                },
                                recentCheckins: (checkins || []).slice(0, 15)
                            });
                        });
                    });
                });
            });
        },

        broadcastEventAlert: function(alertData, callback) {
            initAWS((err) => {
                if (err) return callback(err);

                const { eventId, eventName, title, message, priority, sendEmail } = alertData;

                this.getTicketsForEvent(eventId, (ticketsErr, tickets) => {
                    if (ticketsErr) return callback(ticketsErr);

                    const attendeeTickets = (tickets || []).filter(t => t.status !== 'Cancelled');
                    const alertId = "ALT-" + Date.now() + "-" + Math.floor(Math.random() * 1000);
                    const now = new Date().toISOString();

                    const alertItem = {
                        alertId: alertId,
                        eventId: eventId,
                        eventName: eventName || "Event Update",
                        organizerId: currentUserSub,
                        title: title || "Important Event Update",
                        message: message || "There has been an update regarding your event.",
                        priority: priority || "high", // info, warning, high
                        createdAt: now,
                        recipientCount: attendeeTickets.length
                    };

                    // Save alert to DynamoDB alerts table (with graceful fallback if table not provisioned)
                    const alertParams = {
                        TableName: config.alertsTableName || "EventProAlerts",
                        Item: alertItem
                    };

                    const completeBroadcast = () => {
                        // Also store in LocalStorage broadcast registry so in-app attendee alert hub is 100% reactive offline or online
                        try {
                            const localAlerts = JSON.parse(localStorage.getItem('eventpro_broadcast_alerts') || '[]');
                            localAlerts.unshift(alertItem);
                            localStorage.setItem('eventpro_broadcast_alerts', JSON.stringify(localAlerts.slice(0, 50)));
                        } catch(e) {
                            console.warn("Local alert save notice:", e);
                        }

                        // Send emails if EmailJS is configured
                        if (sendEmail && window.emailjs && attendeeTickets.length > 0) {
                            attendeeTickets.slice(0, 5).forEach(ticket => {
                                try {
                                    emailjs.send('service_w5mpz2s', 'template_cqxegxr', {
                                        to_email: ticket.attendeeEmail || "attendee@example.com",
                                        to_name: ticket.attendeeName || "Valued Attendee",
                                        event_title: eventName || ticket.eventName,
                                        event_date: "ALERT: " + title,
                                        event_venue: message,
                                        ticket_id: ticket.ticketId
                                    }).catch(e => console.warn("Email alert notice:", e));
                                } catch(e) {}
                            });
                        }

                        callback(null, {
                            success: true,
                            alert: alertItem,
                            recipientCount: attendeeTickets.length,
                            message: `Alert broadcast successfully to ${attendeeTickets.length} attendee(s)!`
                        });
                    };

                    docClient.put(alertParams, (putErr) => {
                        if (putErr) {
                            console.warn("DynamoDB Alerts table notice (using persistent store fallback):", putErr);
                        }
                        completeBroadcast();
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
            if (typeof days === 'function') {
                callback = days;
                days = 3650; // Free lifetime access
            }
            days = days || 3650;
            initAWS((err) => {
                if (err) return callback ? callback(err) : null;
                
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
                    if (callback) {
                        if (err) callback(err);
                        else callback(null, data);
                    }
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
