// EventPro Admin Backend v2.5 - Multi-table correlation engine
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

            // 1. Scan Users
            docClient.scan({ TableName: usersTable }, function(err, usersData) {
                if (err) {
                    console.error("Error scanning users:", err);
                    return callback(err);
                }
                const rawUsers = (usersData && usersData.Items) ? usersData.Items : [];

                // 2. Scan Events
                docClient.scan({ TableName: eventsTable }, function(eventsErr, eventsData) {
                    const rawEvents = (!eventsErr && eventsData && eventsData.Items) ? eventsData.Items : [];
                    if (eventsErr) console.warn("Notice: could not scan events table:", eventsErr);

                    // 3. Scan Tickets
                    docClient.scan({ TableName: ticketsTable }, function(ticketsErr, ticketsData) {
                        const rawTickets = (!ticketsErr && ticketsData && ticketsData.Items) ? ticketsData.Items : [];
                        if (ticketsErr) console.warn("Notice: could not scan tickets table:", ticketsErr);

                        // Build organizer lookups from events
                        const organizerIdSet = new Set();
                        const organizerEmailSet = new Set();
                        const organizerEventCounts = {};
                        const organizerEmailCounts = {};

                        let totalGrossSales = 0;
                        let activeEventsCount = 0;
                        let unlistedEventsCount = 0;
                        let featuredEventsCount = 0;

                        rawEvents.forEach(e => {
                            const orgId = e.organizerId || e.creatorId || e.userId;
                            if (orgId) {
                                organizerIdSet.add(orgId);
                                organizerEventCounts[orgId] = (organizerEventCounts[orgId] || 0) + 1;
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

                        // Analyze Tickets & Escrow Metrics
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

                        // Accurate Role Detection across multiple fields (role, userType, user_type, events created)
                        let countAdmins = 0;
                        let countOrganizers = 0;
                        let countAttendees = 0;

                        const enrichedUsers = rawUsers.map(u => {
                            const uEmail = (u.email || '').toLowerCase().trim();
                            const uRole = (u.role || u.userType || u.user_type || u.accountType || '').toLowerCase().trim();

                            const isMasterAdmin = uEmail === 'admin@eventpro24.online' || uEmail === 'admin@eventpro.com' || uRole === 'admin';
                            const hasEvents = (u.userId && organizerIdSet.has(u.userId)) || (uEmail && organizerEmailSet.has(uEmail));
                            const isExplicitOrg = uRole === 'organizer' || uRole.includes('org');

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

                        // Merge any event organizers who created events but whose user profile was not yet registered in EventProUsers
                        const existingUserEmails = new Set(enrichedUsers.map(u => (u.email || '').toLowerCase().trim()).filter(Boolean));
                        const existingUserIds = new Set(enrichedUsers.map(u => u.userId).filter(Boolean));

                        rawEvents.forEach(e => {
                            const eOrgEmail = (e.organizerEmail || '').toLowerCase().trim();
                            const eOrgId = e.organizerId || e.creatorId || e.userId;
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
        },

        // ==========================================
        // HOST SETTLEMENTS & PAYOUT MANAGEMENT (OPTION B)
        // ==========================================
        getPayoutRequests: function(callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            const config = window.EVENTPRO_AWS_CONFIG || {};

            const paymentsTable = config.paymentsTableName || "EventProPayments";
            docClient.scan({ TableName: paymentsTable }, function(err, data) {
                let payouts = [];
                if (!err && data && Array.isArray(data.Items)) {
                    payouts = data.Items.filter(p => p.type === "ORGANIZER_PAYOUT" || (p.paymentId && p.paymentId.startsWith("PO-")) || (p.payoutId && p.payoutId.startsWith("PO-")));
                }

                // Also check users table for payoutHistory / withdrawalDetails
                const usersTable = config.dynamoDBTableName || "EventProUsers";
                docClient.scan({ TableName: usersTable }, function(uErr, uData) {
                    if (!uErr && uData && Array.isArray(uData.Items)) {
                        const existingIds = new Set(payouts.map(p => p.payoutId || p.paymentId));
                        uData.Items.forEach(u => {
                            if (Array.isArray(u.payoutHistory)) {
                                u.payoutHistory.forEach(ph => {
                                    const id = ph.payoutId || ph.paymentId;
                                    if (id && !existingIds.has(id)) {
                                        payouts.push(ph);
                                        existingIds.add(id);
                                    }
                                });
                            } else if (parseFloat(u.withdrawnAmount) > 0 && u.withdrawalDetails && !existingIds.has("LEGACY-" + u.userId)) {
                                payouts.push({
                                    payoutId: "LEGACY-" + u.userId.slice(-6),
                                    paymentId: "LEGACY-" + u.userId.slice(-6),
                                    type: "ORGANIZER_PAYOUT",
                                    userId: u.userId,
                                    organizerName: ((u.firstName || '') + ' ' + (u.lastName || '')).trim() || u.name || "Organizer",
                                    organizerEmail: u.email || "organizer@example.com",
                                    amount: parseFloat(u.withdrawnAmount) || 0,
                                    status: "Pending",
                                    method: u.withdrawalDetails.bankAccount ? "bank" : "upi",
                                    bankName: u.withdrawalDetails.bankName || u.withdrawalDetails.beneficiaryName || "",
                                    bankAccount: u.withdrawalDetails.bankAccount || "",
                                    bankIFSC: u.withdrawalDetails.bankIFSC || u.withdrawalDetails.bankIfsc || "",
                                    upiId: u.withdrawalDetails.upiId || "",
                                    requestedAt: u.withdrawalDetails.requestedAt || u.updatedAt || new Date().toISOString()
                                });
                            }
                        });
                    }

                    payouts.sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
                    callback(null, payouts);
                });
            });
        },

        settlePayout: function(payoutId, utrNumber, callback) {
            if (!docClient && !init()) return callback(new Error("AWS not initialized"));
            const config = window.EVENTPRO_AWS_CONFIG || {};
            const apiBase = (config.apiGatewayUrl || 'https://s3eg7kdaja.execute-api.ap-south-1.amazonaws.com/prod').replace(/\/+$/, '');
            const now = new Date().toISOString();

            this.getPayoutRequests((err, list) => {
                if (err) return callback(err);
                const payout = (list || []).find(p => (p.payoutId === payoutId || p.paymentId === payoutId));
                if (!payout) return callback(new Error("Payout request not found: " + payoutId));

                const paymentsTable = config.paymentsTableName || "EventProPayments";
                const pKey = payout.paymentId || payout.payoutId;

                const putRecord = {
                    ...payout,
                    paymentId: pKey,
                    payoutId: pKey,
                    status: "Settled",
                    bankUTR: utrNumber,
                    settledAt: now,
                    settledBy: "Platform Admin"
                };

                docClient.put({
                    TableName: paymentsTable,
                    Item: putRecord
                }, function(upErr) {
                    if (upErr) console.warn("Notice: could not save settled record to payments table:", upErr);

                    // Update User's payoutHistory in EventProUsers
                    if (payout.userId) {
                        const usersTable = config.dynamoDBTableName || "EventProUsers";
                        docClient.get({ TableName: usersTable, Key: { userId: payout.userId } }, function(uErr, uData) {
                            if (!uErr && uData && uData.Item) {
                                const history = Array.isArray(uData.Item.payoutHistory) ? uData.Item.payoutHistory : [];
                                const updatedHistory = history.map(item => {
                                    if (item.payoutId === payoutId || item.paymentId === payoutId) {
                                        return { ...item, status: "Settled", bankUTR: utrNumber, settledAt: now };
                                    }
                                    return item;
                                });
                                if (!updatedHistory.some(item => item.payoutId === payoutId || item.paymentId === payoutId)) {
                                    updatedHistory.unshift(putRecord);
                                }
                                docClient.update({
                                    TableName: usersTable,
                                    Key: { userId: payout.userId },
                                    UpdateExpression: "SET payoutHistory = :h",
                                    ExpressionAttributeValues: { ":h": updatedHistory }
                                }, () => {});
                            }
                        });
                    }

                    // Dispatch transactional confirmation email to organizer
                    if (payout.organizerEmail) {
                        const destText = payout.bankAccount ? 
                            `${payout.bankName ? payout.bankName + ' • ' : ''}A/C: ••••${payout.bankAccount.slice(-4)} (IFSC: ${payout.bankIFSC})` :
                            `UPI ID: ${payout.upiId}`;

                        fetch(`${apiBase}/api/send-email`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                type: 'alert',
                                to_email: payout.organizerEmail,
                                to_name: payout.organizerName || 'Organizer',
                                subject: `💸 Payout Settled: ₹${payout.amount} Transferred via NEFT/IMPS`,
                                alert_title: 'Host Settlement Disbursed',
                                alert_message: `Good news! Your withdrawal request of ₹${payout.amount} has been disbursed and settled by the EventPro finance desk.\n\nDestination: ${destText}\nBank Transaction / UTR Ref: ${utrNumber}\nSettled On: ${new Date().toLocaleDateString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}\n\nFunds should reflect in your account according to your bank's clearing cycle. Thank you for partnering with EventPro!`,
                                priority: 'high'
                            })
                        }).catch(e => console.warn("Payout email dispatch notice:", e));
                    }

                    callback(null, { success: true, payoutId: payoutId, bankUTR: utrNumber });
                });
            });
        }
    };
})();
