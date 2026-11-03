const fs = require('fs');
const path = require('path');

// 1. Update attendee-backend.js to add resetSplitPayment
const backendPath = path.join(__dirname, '../Attendee_Dashboard/attendee-backend.js');
let backend = fs.readFileSync(backendPath, 'utf8');

if (!backend.includes('resetSplitPayment:')) {
    const targetMarker = 'resultAttr.activeMemberTicketId = memberTicketId;';
    const targetIdx = backend.indexOf(targetMarker);
    if (targetIdx !== -1) {
        // find the end of this method: '        },'
        const closeMethodIdx = backend.indexOf('        },', targetIdx);
        if (closeMethodIdx !== -1) {
            const insertPoint = closeMethodIdx + '        },'.length;
            const resetCode = `

        resetSplitPayment: function(ticketId, memberIndex, callback) {
            initAWS((err) => {
                if (err) return callback(err);
                const params = {
                    TableName: config.ticketsTableName,
                    Key: { ticketId: ticketId }
                };
                docClient.get(params, (getErr, data) => {
                    if (getErr || !data.Item) return callback(getErr || new Error("Ticket record not found"));
                    const t = data.Item;
                    if (!t.splitMembers || !t.splitMembers[memberIndex]) {
                        return callback(new Error("Split member not found"));
                    }

                    t.splitMembers[memberIndex].status = "Pending";
                    delete t.splitMembers[memberIndex].paidAt;
                    delete t.splitMembers[memberIndex].name;
                    delete t.splitMembers[memberIndex].email;

                    const paidCount = t.splitMembers.filter(m => m.status === "Paid").length;
                    t.paidMembers = paidCount;
                    t.status = "Valid";
                    t.splitStatus = paidCount >= (t.totalSplitMembers || 2) ? "Fully Settled" : "Pending Friends";

                    const memberTicketId = \`\${ticketId}-M\${memberIndex + 1}\`;
                    docClient.delete({
                        TableName: config.ticketsTableName,
                        Key: { ticketId: memberTicketId }
                    }, (delErr) => {
                        if (delErr) console.warn("Could not delete sub-ticket:", delErr);
                    });

                    const updateParams = {
                        TableName: config.ticketsTableName,
                        Key: { ticketId: ticketId },
                        UpdateExpression: "SET splitMembers = :sm, paidMembers = :pm, #s = :st, splitStatus = :ss",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: {
                            ":sm": t.splitMembers,
                            ":pm": paidCount,
                            ":st": t.status,
                            ":ss": t.splitStatus
                        },
                        ReturnValues: "ALL_NEW"
                    };

                    docClient.update(updateParams, (upErr, upData) => {
                        if (upErr) return callback(upErr);
                        callback(null, upData.Attributes || t);
                    });
                });
            });
        },`;
            backend = backend.slice(0, insertPoint) + resetCode + backend.slice(insertPoint);
            fs.writeFileSync(backendPath, backend, 'utf8');
            console.log('Successfully added resetSplitPayment to attendee-backend.js');
        }
    }
} else {
    console.log('resetSplitPayment already exists in attendee-backend.js');
}

// 2. Update Your_Booking.html to:
// a) prevent duplicate child tickets if the buyer owns the parent group split
// b) enhance the Split Hub modal with [Pay Online], [Simulate Pay], [Reset to Unpaid]
const yourBookingPath = path.join(__dirname, '../Attendee_Dashboard/Your_Booking.html');
let yourBooking = fs.readFileSync(yourBookingPath, 'utf8');

// Filter child tickets from display if the parent ticket is in the buyer's own list
if (!yourBooking.includes('parentSplitIds')) {
    const oldSort = 'tickets.sort((a,b) => {';
    const newSort = `// Filter out child sub-tickets if the buyer already has the parent group ticket card
                        const parentSplitIds = new Set(tickets.filter(t => t.isGroupSplit).map(t => t.ticketId));
                        tickets = tickets.filter(t => !(t.isGroupSplitMember && parentSplitIds.has(t.parentTicketId)));

                        tickets.sort((a,b) => {`;
    if (yourBooking.includes(oldSort)) {
        yourBooking = yourBooking.replace(oldSort, newSort);
        console.log('Updated Your_Booking.html to filter duplicate member sub-tickets');
    }
}

// Enhance Split Hub members rendering
const oldRenderMembersMarker = 'renderMembers(members, paidCount) {';
const oldRenderMembersIdx = yourBooking.indexOf(oldRenderMembersMarker);
if (oldRenderMembersIdx !== -1) {
    const endRenderMembersMarker = 'renderMembers(ticket.splitMembers || [], ticket.paidMembers || 1);';
    const endRenderMembersIdx = yourBooking.indexOf(endRenderMembersMarker, oldRenderMembersIdx);
    if (endRenderMembersIdx !== -1) {
        const replacementMembersFn = `renderMembers(members, paidCount) {
                    const total = ticket.totalSplitMembers || members.length || 2;
                    const isSettled = paidCount >= total;
                    updateBanner(paidCount, total, isSettled);

                    if (!listEl) return;
                    listEl.innerHTML = '';

                    (members || []).forEach((m, idx) => {
                        const isPaid = m.status === 'Paid';
                        const memberPayUrl = \`\${window.location.origin}/Attendee_Dashboard/Pay_Split.html?ticketId=\${encodeURIComponent(ticket.ticketId)}&m=\${idx}\`;
                        const row = document.createElement('div');
                        row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:#161922; border:1px solid #232a3b; padding:12px 14px; border-radius:12px; font-size:0.82rem; gap:10px;';
                        row.innerHTML = \`
                            <div style="flex: 1; min-width: 0;">
                                <strong style="color:#fff; display:block; font-size:0.88rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">\${m.name || 'Friend #' + (idx + 1)}</strong>
                                <span style="font-size:0.75rem; color:\${isPaid ? '#10b981' : '#f59e0b'}; font-weight:600;">
                                    \${isPaid ? '✓ Paid ₹' + (m.amount || ticket.perPersonAmount || 0) : '⏳ Pending ₹' + (m.amount || ticket.perPersonAmount || 0)}
                                </span>
                            </div>
                            <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end;">
                                \${isPaid ? \`
                                    <span style="background:rgba(16,185,129,0.15); color:#10b981; font-weight:700; padding:4px 8px; border-radius:6px; font-size:0.72rem; border:1px solid rgba(16,185,129,0.3);">PAID</span>
                                    <a href="\${memberPayUrl}" target="_blank" style="background:#1e2433; color:#93c5fd; border:1px solid #2b354c; padding:5px 9px; border-radius:6px; font-size:0.72rem; font-weight:700; text-decoration:none; display:inline-flex; align-items:center;">View Pass</a>
                                    <button type="button" class="reset-split-pay-btn" data-index="\${idx}" style="background:rgba(239,68,68,0.1); color:#f87171; border:1px solid rgba(239,68,68,0.25); padding:5px 9px; border-radius:6px; font-size:0.72rem; font-weight:600; cursor:pointer;" title="Reset this friend's share back to pending to test payment again">Reset</button>
                                \` : \`
                                    <a href="\${memberPayUrl}" target="_blank" style="background:linear-gradient(135deg, #10b981, #059669); color:#fff; padding:5px 10px; border-radius:6px; font-size:0.72rem; font-weight:700; text-decoration:none; display:inline-flex; align-items:center;">Pay Online</a>
                                    <button type="button" class="simulate-split-pay-btn" data-index="\${idx}" style="background:rgba(59,130,246,0.18); color:#60a5fa; border:1px solid rgba(59,130,246,0.35); padding:5px 9px; border-radius:6px; font-size:0.72rem; font-weight:700; cursor:pointer;">Simulate Pay</button>
                                \`}
                            </div>
                        \`;
                        listEl.appendChild(row);
                    });

                    // Bind Simulate Pay Buttons
                    listEl.querySelectorAll('.simulate-split-pay-btn').forEach(b => {
                        b.addEventListener('click', function() {
                            const memberIndex = parseInt(this.getAttribute('data-index'), 10);
                            this.disabled = true;
                            this.textContent = 'Settling...';

                            if (window.AttendeeBackend && typeof window.AttendeeBackend.updateSplitPayment === 'function') {
                                window.AttendeeBackend.updateSplitPayment(ticket.ticketId, memberIndex, (err, updated) => {
                                    if (!err && updated) {
                                        ticket.splitMembers = updated.splitMembers;
                                        ticket.paidMembers = updated.paidMembers;
                                        ticket.status = updated.status;
                                        ticket.splitStatus = updated.splitStatus;
                                        renderMembers(updated.splitMembers, updated.paidMembers);
                                        loadBookings();
                                    } else {
                                        alert('Could not update payment status: ' + (err ? err.message : 'Unknown error'));
                                        this.disabled = false;
                                        this.textContent = 'Simulate Pay';
                                    }
                                });
                            }
                        });
                    });

                    // Bind Reset Buttons
                    listEl.querySelectorAll('.reset-split-pay-btn').forEach(b => {
                        b.addEventListener('click', function() {
                            const memberIndex = parseInt(this.getAttribute('data-index'), 10);
                            if (!confirm('Reset this friend\\'s share back to Pending? This will allow you to test paying again.')) return;
                            this.disabled = true;
                            this.textContent = 'Resetting...';

                            if (window.AttendeeBackend && typeof window.AttendeeBackend.resetSplitPayment === 'function') {
                                window.AttendeeBackend.resetSplitPayment(ticket.ticketId, memberIndex, (err, updated) => {
                                    if (!err && updated) {
                                        ticket.splitMembers = updated.splitMembers;
                                        ticket.paidMembers = updated.paidMembers;
                                        ticket.status = updated.status;
                                        ticket.splitStatus = updated.splitStatus;
                                        renderMembers(updated.splitMembers, updated.paidMembers);
                                        loadBookings();
                                    } else {
                                        alert('Could not reset share: ' + (err ? err.message : 'Unknown error'));
                                        this.disabled = false;
                                        this.textContent = 'Reset';
                                    }
                                });
                            }
                        });
                    });
                }

                `;
        yourBooking = yourBooking.slice(0, oldRenderMembersIdx) + replacementMembersFn + yourBooking.slice(endRenderMembersIdx);
        fs.writeFileSync(yourBookingPath, yourBooking, 'utf8');
        console.log('Successfully enhanced Split Hub modal in Your_Booking.html');
    }
}

// 3. Update Pay_Split.html to handle both Unauthenticated Cognito and friendly Sign In fallback
const paySplitPath = path.join(__dirname, '../Attendee_Dashboard/Pay_Split.html');
let paySplit = fs.readFileSync(paySplitPath, 'utf8');

// Ensure Pay_Split.html includes SDK and attendee-backend.js with fallback
if (!paySplit.includes('id="signInPromptState"')) {
    // Add signInPromptState view inside mainCard
    const errorStateMarker = '<div id="errorState" style="display: none;">';
    const signInPromptHTML = `
            <!-- Friendly Guest Sign In Prompt View -->
            <div id="signInPromptState" style="display: none; text-align: center; padding: 24px 10px;">
                <div style="width: 58px; height: 58px; background: rgba(99, 102, 241, 0.15); border: 2px solid rgba(99, 102, 241, 0.4); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; font-size: 1.6rem;">
                    🔒
                </div>
                <h2 style="color: #fff; font-size: 1.3rem; font-weight: 800; margin-bottom: 8px;">Claim Your Group Seat</h2>
                <p style="color: var(--text-muted); font-size: 0.88rem; line-height: 1.5; margin-bottom: 22px; max-width: 360px; margin-left: auto; margin-right: auto;">
                    Sign in or create a quick account with your email to view this event reservation and pay your share.
                </p>
                <div style="display: flex; flex-direction: column; gap: 10px; max-width: 300px; margin: 0 auto 16px;">
                    <a id="signInBtnRedirect" href="../SIGNIN.html" class="pay-btn" style="text-decoration: none; padding: 12px; font-size: 0.95rem;">
                        Sign In to Pay Share
                    </a>
                    <a id="signUpBtnRedirect" href="../SIGNUP.html" class="btn-view-bookings" style="text-decoration: none; padding: 12px; font-size: 0.88rem;">
                        Create Free Account
                    </a>
                </div>
            </div>
`;
    if (paySplit.includes(errorStateMarker)) {
        paySplit = paySplit.replace(errorStateMarker, signInPromptHTML + '\n            ' + errorStateMarker);
        console.log('Added signInPromptState view to Pay_Split.html');
    }
}

// Ensure scripts for AWS SDK and attendee-backend are loaded in Pay_Split.html
if (!paySplit.includes('attendee-backend.js')) {
    const awsScriptAnchor = '<script src="../aws-config.js"></script>';
    const fullAwsScripts = `<script src="https://sdk.amazonaws.com/js/aws-sdk-2.1408.0.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/amazon-cognito-identity-js@6.3.12/dist/amazon-cognito-identity.min.js"></script>
    <script src="../aws-config.js"></script>
    <script src="attendee-backend.js"></script>`;
    if (paySplit.includes(awsScriptAnchor)) {
        paySplit = paySplit.replace(awsScriptAnchor, fullAwsScripts);
        console.log('Added AWS SDK and attendee-backend.js to Pay_Split.html');
    }
}

// Update loadSplitDetails in Pay_Split.html to seamlessly handle unauthenticated guest error
const oldLoadSplitMarker = 'function loadSplitDetails() {';
const oldLoadSplitIdx = paySplit.indexOf(oldLoadSplitMarker);
if (oldLoadSplitIdx !== -1) {
    const endLoadSplitMarker = 'function renderTicketUI(ticket) {';
    const endLoadSplitIdx = paySplit.indexOf(endLoadSplitMarker, oldLoadSplitIdx);
    if (endLoadSplitIdx !== -1) {
        const robustLoadSplitFn = `function loadSplitDetails() {
                const signInState = document.getElementById('signInPromptState');
                const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
                const signInLink = document.getElementById('signInBtnRedirect');
                const signUpLink = document.getElementById('signUpBtnRedirect');
                if (signInLink) signInLink.href = \`../SIGNIN.html?redirect=\${returnUrl}\`;
                if (signUpLink) signUpLink.href = \`../SIGNUP.html?redirect=\${returnUrl}\`;

                if (!window.AttendeeBackend || !window.AttendeeBackend.getSplitTicket) {
                    setTimeout(loadSplitDetails, 200);
                    return;
                }

                window.AttendeeBackend.getSplitTicket(ticketId, (err, ticket) => {
                    loadingState.style.display = 'none';

                    if (err || !ticket) {
                        const errMsg = (err && err.message) || '';
                        // If Identity Pool does not permit guest access without signin
                        if (errMsg.includes('Unauthenticated access') || errMsg.includes('identity pool') || errMsg.includes('not authorized') || errMsg.includes('Missing credentials')) {
                            if (signInState) signInState.style.display = 'block';
                            else {
                                errorState.style.display = 'block';
                                errorMessage.textContent = 'Please sign in to view and pay your group reservation.';
                            }
                            return;
                        }

                        errorState.style.display = 'block';
                        errorMessage.textContent = errMsg || 'Reservation record not found.';
                        return;
                    }

                    currentTicket = ticket;

                    // 1. If parent ticket itself is already used
                    if (ticket.status === 'Used') {
                        showTicketUsedView(ticket, ticket.attendeeName || 'Attendee', ticket.ticketId, ticket.checkedInAt);
                        return;
                    }

                    // 2. If a specific member is targeted via ?m= parameter
                    const paramIdx = memberParam !== null ? parseInt(memberParam, 10) : null;
                    if (paramIdx !== null) {
                        const member = ticket.splitMembers && ticket.splitMembers[paramIdx];
                        const subId = (member && (member.memberTicketId || member.subTicketId)) || \`\${ticket.ticketId}-M\${paramIdx + 1}\`;

                        if (member && (member.status === 'Used' || member.isUsed)) {
                            showTicketUsedView(ticket, member.name, subId, member.checkedInAt);
                            return;
                        }

                        window.AttendeeBackend.getSplitTicket(subId, (subErr, subTicket) => {
                            if (!subErr && subTicket && subTicket.status === 'Used') {
                                showTicketUsedView(ticket, subTicket.attendeeName || (member && member.name), subId, subTicket.checkedInAt);
                                return;
                            }
                            renderTicketUI(ticket);
                        });
                        return;
                    }

                    renderTicketUI(ticket);
                });
            }

            `;
        paySplit = paySplit.slice(0, oldLoadSplitIdx) + robustLoadSplitFn + paySplit.slice(endLoadSplitIdx);
        console.log('Successfully updated loadSplitDetails in Pay_Split.html');
    }
}

// Update finalizePayment in Pay_Split.html
const oldFinalizeMarker = 'function finalizePayment(payerName, payerEmail) {';
const oldFinalizeIdx = paySplit.indexOf(oldFinalizeMarker);
if (oldFinalizeIdx !== -1) {
    const endFinalizeMarker = '// Start Loading';
    const endFinalizeIdx = paySplit.indexOf(endFinalizeMarker, oldFinalizeIdx);
    if (endFinalizeIdx !== -1) {
        const robustFinalizeFn = `function finalizePayment(payerName, payerEmail) {
                payBtn.innerHTML = '<span>Locking Your Seat & Activating Dynamic Pass...</span>';

                window.AttendeeBackend.updateSplitPayment(ticketId, selectedMemberIndex, payerName, payerEmail, (err, updated) => {
                    payBtn.disabled = false;

                    if (typeof confetti === 'function') {
                        confetti({
                            particleCount: 90,
                            spread: 70,
                            origin: { y: 0.6 }
                        });
                    }

                    const subTicketId = (updated && updated.activeMemberTicketId) || \`\${ticketId}-M\${selectedMemberIndex + 1}\`;
                    const directPassUrl = \`\${window.location.origin}\${window.location.pathname}?ticketId=\${encodeURIComponent(ticketId)}&m=\${selectedMemberIndex}\`;

                    try {
                        const localPasses = JSON.parse(localStorage.getItem('eventpro_my_passes') || '[]');
                        if (!localPasses.some(p => p.ticketId === subTicketId)) {
                            localPasses.push({
                                ticketId: subTicketId,
                                parentTicketId: ticketId,
                                memberIndex: selectedMemberIndex,
                                eventName: currentTicket.eventName,
                                date: currentTicket.date,
                                time: currentTicket.time,
                                location: currentTicket.location,
                                attendeeName: payerName,
                                attendeeEmail: payerEmail,
                                directPassUrl: directPassUrl
                            });
                            localStorage.setItem('eventpro_my_passes', JSON.stringify(localPasses));
                        }
                    } catch (e) {
                        console.warn('Could not cache pass locally:', e);
                    }

                    showRollingPass(subTicketId, currentTicket.eventId, payerName, currentTicket, selectedMemberIndex);
                });
            }

            `;
        paySplit = paySplit.slice(0, oldFinalizeIdx) + robustFinalizeFn + paySplit.slice(endFinalizeIdx);
        console.log('Successfully updated finalizePayment in Pay_Split.html');
    }
}

fs.writeFileSync(paySplitPath, paySplit, 'utf8');

console.log('ALL UPDATES COMPLETE!');

