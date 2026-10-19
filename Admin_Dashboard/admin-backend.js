window.AdminBackend = (function() {
    let docClient;

    function init() {
        if (!window.AWS) {
            console.error("AWS SDK not loaded");
            return false;
        }
        if (!AWS.config.credentials) {
            console.error("AWS credentials not set yet.");
            return false;
        }
        docClient = new AWS.DynamoDB.DocumentClient();
        return true;
    }

    return {
        getDashboardStats: function(callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));

            const config = window.EVENTPRO_AWS_CONFIG || {};
            const usersTable = config.dynamoDBTableName || "EventProUsers";
            const eventsTable = config.eventsTableName || "EventProEvents";
            const ticketsTable = config.ticketsTableName || "EventProTickets";
            const checkinsTable = config.checkinsTableName || "EventProCheckins";

            // 1. Scan Users
            docClient.scan({ TableName: usersTable }, function(err, usersData) {
                if (err) return callback(err);
                const rawUsers = usersData.Items || [];

                // 2. Scan Events
                docClient.scan({ TableName: eventsTable }, function(eventsErr, eventsData) {
                    if (eventsErr) return callback(eventsErr);
                    const rawEvents = eventsData.Items || [];

                    // 3. Scan Tickets (for revenue, escrow deposits, and attendee correlation)
                    docClient.scan({ TableName: ticketsTable }, function(ticketsErr, ticketsData) {
                        const rawTickets = (!ticketsErr && ticketsData) ? (ticketsData.Items || []) : [];

                        // Build cross-reference lookups
                        const organizerIdSet = new Set();
                        const organizerEmailSet = new Set();
                        const organizerEventCounts = {};
                        const organizerEmailCounts = {};

                        let totalGrossSales = 0;
                        let activeEventsCount = 0;
                        let unlistedEventsCount = 0;
                        let featuredEventsCount = 0;

                        rawEvents.forEach(e => {
                            if (e.organizerId) {
                                organizerIdSet.add(e.organizerId);
                                organizerEventCounts[e.organizerId] = (organizerEventCounts[e.organizerId] || 0) + 1;
                            }
                            if (e.organizerEmail) {
                                const oEmail = e.organizerEmail.toLowerCase().trim();
                                organizerEmailSet.add(oEmail);
                                organizerEmailCounts[oEmail] = (organizerEmailCounts[oEmail] || 0) + 1;
                            }

                            const isUnlisted = e.unlisted === true || e.unlisted === 'true';
                            if (isUnlisted) unlistedEventsCount++;
                            else activeEventsCount++;

                            if (e.featured === true || e.featured === 'true') featuredEventsCount++;

                            const tSold = parseInt(e.ticketsSold, 10) || 0;
                            const pr = parseFloat(e.price) || 0;
                            const rev = parseFloat(e.revenue) || (tSold * pr) || 0;
                            totalGrossSales += rev;
                        });

                        // Analyze Tickets & Escrow Refund Metrics
                        let totalTicketsSold = 0;
                        let totalEscrowCollected = 0;
                        let totalEscrowRefunded = 0;
                        let totalEscrowHeld = 0;
                        let totalSplitBookings = 0;
                        let settledSplitsCount = 0;
                        let pendingSplitsCount = 0;

                        const attendeeTicketCounts = {};
                        const attendeeEmailCounts = {};

                        rawTickets.forEach(t => {
                            if (t.status !== 'Cancelled') {
                                totalTicketsSold += (parseInt(t.quantity, 10) || 1);
                            }

                            if (t.attendeeId) {
                                attendeeTicketCounts[t.attendeeId] = (attendeeTicketCounts[t.attendeeId] || 0) + 1;
                            }
                            if (t.attendeeEmail) {
                                const aEmail = t.attendeeEmail.toLowerCase().trim();
                                attendeeEmailCounts[aEmail] = (attendeeEmailCounts[aEmail] || 0) + 1;
                            }

                            // Smart Escrow Deposit tracking
                            const hasDeposit = t.hasDeposit === true || (parseFloat(t.depositAmount) > 0);
                            const depAmount = parseFloat(t.depositAmount) || 0;

                            if (hasDeposit && depAmount > 0) {
                                totalEscrowCollected += depAmount;
                                if (t.depositStatus === 'Refunded') {
                                    totalEscrowRefunded += depAmount;
                                } else {
                                    totalEscrowHeld += depAmount;
                                }
                            }

                            // Group Split Tracking
                            if (t.isGroupSplit) {
                                totalSplitBookings++;
                                if (t.splitStatus === 'Fully Settled') settledSplitsCount++;
                                else pendingSplitsCount++;
                            }
                        });

                        // Correlate and identify exact roles (Admin vs Organizer vs Attendee)
                        let countAdmins = 0;
                        let countOrganizers = 0;
                        let countAttendees = 0;

                        const enrichedUsers = rawUsers.map(u => {
                            const uEmail = (u.email || '').toLowerCase().trim();
                            const isMasterAdmin = uEmail === 'admin@eventpro.com' || u.role === 'admin' || u.userType === 'admin';
                            const hasEvents = (u.userId && organizerIdSet.has(u.userId)) || (uEmail && organizerEmailSet.has(uEmail));
                            const isExplicitOrg = u.role === 'organizer' || u.userType === 'organizer';

                            let detectedRole = 'attendee';
                            if (isMasterAdmin) {
                                detectedRole = 'admin';
                                countAdmins++;
                            } else if (isExplicitOrg || hasEvents) {
                                detectedRole = 'organizer';
                                countOrganizers++;
                            } else {
                                detectedRole = 'attendee';
                                countAttendees++;
                            }

                            const eventsCount = (u.userId && organizerEventCounts[u.userId]) || (uEmail && organizerEmailCounts[uEmail]) || 0;
                            const ticketsCount = (u.userId && attendeeTicketCounts[u.userId]) || (uEmail && attendeeEmailCounts[uEmail]) || 0;

                            return {
                                ...u,
                                detectedRole: detectedRole,
                                eventsCount: eventsCount,
                                ticketsCount: ticketsCount
                            };
                        });

                        // Check for event organizers that haven't yet been registered in EventProUsers table
                        const existingUserEmails = new Set(enrichedUsers.map(u => (u.email || '').toLowerCase().trim()));
                        const existingUserIds = new Set(enrichedUsers.map(u => u.userId));

                        rawEvents.forEach(e => {
                            const eOrgEmail = (e.organizerEmail || '').toLowerCase().trim();
                            const eOrgId = e.organizerId;
                            if (eOrgId && !existingUserIds.has(eOrgId) && (!eOrgEmail || !existingUserEmails.has(eOrgEmail))) {
                                existingUserIds.add(eOrgId);
                                if (eOrgEmail) existingUserEmails.add(eOrgEmail);
                                countOrganizers++;
                                enrichedUsers.push({
                                    userId: eOrgId,
                                    email: e.organizerEmail || 'organizer@eventpro.com',
                                    firstName: e.organizerName || 'Event',
                                    lastName: 'Organizer',
                                    role: 'organizer',
                                    detectedRole: 'organizer',
                                    eventsCount: organizerEventCounts[eOrgId] || 1,
                                    ticketsCount: 0,
                                    createdAt: e.createdAt || new Date().toISOString()
                                });
                            }
                        });

                        const PLATFORM_FEE_PERCENT = 0.03; // 3% commission on ticket sales
                        const platformRevenue = totalGrossSales * PLATFORM_FEE_PERCENT;

                        const stats = {
                            totalUsers: enrichedUsers.length,
                            organizers: countOrganizers,
                            attendees: countAttendees,
                            admins: countAdmins,
                            usersList: enrichedUsers,
                            
                            // Events data
                            totalEvents: rawEvents.length,
                            activeEvents: activeEventsCount,
                            unlistedEvents: unlistedEventsCount,
                            featuredEvents: featuredEventsCount,
                            eventsList: rawEvents,

                            // Financial & Escrow metrics
                            totalGrossSales: totalGrossSales,
                            platformRevenue: platformRevenue,
                            totalTicketsSold: totalTicketsSold,
                            escrowStats: {
                                totalCollected: totalEscrowCollected,
                                totalRefunded: totalEscrowRefunded,
                                totalHeld: totalEscrowHeld,
                                totalSplitBookings: totalSplitBookings,
                                settledSplits: settledSplitsCount,
                                pendingSplits: pendingSplitsCount
                            }
                        };

                        callback(null, stats);
                    });
                });
            });
        },

        // Event Moderation APIs
        toggleEventUnlisted: function(eventId, currentUnlisted, callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            const config = window.EVENTPRO_AWS_CONFIG || {};
            const newUnlisted = !currentUnlisted;

            const params = {
                TableName: config.eventsTableName || "EventProEvents",
                Key: { eventId: eventId },
                UpdateExpression: "SET unlisted = :u",
                ExpressionAttributeValues: {
                    ":u": newUnlisted
                },
                ReturnValues: "ALL_NEW"
            };

            docClient.update(params, function(err, data) {
                if (err) callback(err);
                else callback(null, data.Attributes);
            });
        },

        toggleEventFeatured: function(eventId, currentFeatured, callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            const config = window.EVENTPRO_AWS_CONFIG || {};
            const newFeatured = !currentFeatured;

            const params = {
                TableName: config.eventsTableName || "EventProEvents",
                Key: { eventId: eventId },
                UpdateExpression: "SET featured = :f",
                ExpressionAttributeValues: {
                    ":f": newFeatured
                },
                ReturnValues: "ALL_NEW"
            };

            docClient.update(params, function(err, data) {
                if (err) callback(err);
                else callback(null, data.Attributes);
            });
        },

        deleteEvent: function(eventId, callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            const config = window.EVENTPRO_AWS_CONFIG || {};

            const params = {
                TableName: config.eventsTableName || "EventProEvents",
                Key: { eventId: eventId }
            };

            docClient.delete(params, function(err) {
                if (err) callback(err);
                else callback(null);
            });
        },

        // User Management APIs
        updateUserRole: function(userId, newRole, callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            const config = window.EVENTPRO_AWS_CONFIG || {};

            const params = {
                TableName: config.dynamoDBTableName || "EventProUsers",
                Key: { userId: userId },
                UpdateExpression: "SET #r = :role, userType = :role",
                ExpressionAttributeNames: { "#r": "role" },
                ExpressionAttributeValues: { ":role": newRole },
                ReturnValues: "ALL_NEW"
            };

            docClient.update(params, function(err, data) {
                if (err) callback(err);
                else callback(null, data.Attributes);
            });
        },

        deleteUser: function(userId, callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            const config = window.EVENTPRO_AWS_CONFIG || {};
            
            const params = {
                TableName: config.dynamoDBTableName || "EventProUsers",
                Key: { userId: userId }
            };

            docClient.delete(params, function(err) {
                if (err) callback(err);
                else callback(null);
            });
        }
    };
})();
