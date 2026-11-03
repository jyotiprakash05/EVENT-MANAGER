/**
 * EventPro - Global Information Tooltip Manager
 * Guarantees that any (.info-circle) description fits perfectly in the viewport.
 * - Prevents clipping by parent elements with overflow: hidden or overflow-y: auto
 * - Auto-detects top/bottom/left/right boundaries and clamps inside screen
 * - Supports both hover (desktop) and tap/click (mobile & desktop)
 * - Prevents native browser title collisions
 */
(function() {
    // Ensure nested .info-tooltip contents are hidden from standard layout flow and styled cleanly
    try {
        if (!document.getElementById('eventpro-tooltip-manager-styles')) {
            const style = document.createElement('style');
            style.id = 'eventpro-tooltip-manager-styles';
            style.textContent = `
                .info-circle .info-tooltip { display: none !important; }
                .info-circle { cursor: pointer; display: inline-flex; align-items: center; justify-content: center; user-select: none; }
            `;
            if (document.head) {
                document.head.appendChild(style);
            } else {
                document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            }
        }
    } catch(e) {}

    let tooltipEl = null;
    let arrowEl = null;
    let activeCircle = null;
    let hideTimer = null;

    function getOrCreateTooltip() {
        if (!tooltipEl) {
            tooltipEl = document.createElement('div');
            tooltipEl.id = 'eventpro-global-tooltip';
            tooltipEl.setAttribute('role', 'tooltip');
            tooltipEl.style.cssText = `
                position: fixed;
                z-index: 2147483647;
                display: none;
                opacity: 0;
                pointer-events: auto;
                transition: opacity 0.16s ease, transform 0.16s ease;
                width: max-content;
                max-width: min(340px, calc(100vw - 28px));
                max-height: calc(100vh - 28px);
                overflow-y: auto;
                background: #0d111a;
                border: 1px solid rgba(255, 255, 255, 0.2);
                box-shadow: 0 16px 40px rgba(0, 0, 0, 0.9), 0 0 0 1px rgba(255, 255, 255, 0.08);
                border-radius: 10px;
                padding: 10px 14px;
                color: #e2e8f0;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                font-size: 0.78rem;
                font-weight: 500;
                line-height: 1.45;
                text-align: left;
                box-sizing: border-box;
                word-wrap: break-word;
                overflow-wrap: break-word;
                white-space: normal;
            `;

            arrowEl = document.createElement('div');
            arrowEl.style.cssText = `
                position: absolute;
                width: 10px;
                height: 10px;
                background: #0d111a;
                border: 1px solid rgba(255, 255, 255, 0.2);
                transform: rotate(45deg);
                z-index: -1;
            `;
            tooltipEl.appendChild(arrowEl);

            tooltipEl.addEventListener('mouseenter', () => {
                if (hideTimer) {
                    clearTimeout(hideTimer);
                    hideTimer = null;
                }
            });

            tooltipEl.addEventListener('mouseleave', () => {
                hideTooltip();
            });

            document.body.appendChild(tooltipEl);
        }
        return tooltipEl;
    }

    function showTooltipFor(circle) {
        if (!circle) return;
        if (hideTimer) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }

        // Suppress browser default tooltip popup if title attribute exists
        if (circle.hasAttribute('title') && circle.getAttribute('title')) {
            circle.dataset.nativeTitle = circle.getAttribute('title');
            circle.removeAttribute('title');
        }

        activeCircle = circle;
        const tip = getOrCreateTooltip();

        const contentNode = circle.querySelector('.info-tooltip');
        let htmlContent = '';
        if (contentNode) {
            htmlContent = contentNode.innerHTML;
        } else if (circle.dataset.tooltip) {
            htmlContent = circle.dataset.tooltip;
        } else if (circle.dataset.nativeTitle) {
            htmlContent = circle.dataset.nativeTitle;
        }

        if (!htmlContent || !htmlContent.trim()) return;

        tip.innerHTML = htmlContent;
        tip.appendChild(arrowEl);

        tip.querySelectorAll('strong').forEach(str => {
            str.style.display = 'block';
            str.style.color = '#ffffff';
            str.style.marginBottom = '4px';
            str.style.fontSize = '0.82rem';
            str.style.fontWeight = '700';
            str.style.letterSpacing = '-0.01em';
        });

        tip.style.display = 'block';
        tip.style.opacity = '0';
        tip.style.transform = 'scale(0.96)';

        const rect = circle.getBoundingClientRect();
        const tipRect = tip.getBoundingClientRect();
        const tipWidth = tipRect.width;
        const tipHeight = tipRect.height;
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let top = 0;
        let isBelow = false;
        const spaceAbove = rect.top;
        const spaceBelow = viewportHeight - rect.bottom;

        if (spaceAbove >= tipHeight + 14) {
            top = rect.top - tipHeight - 10;
            isBelow = false;
        } else if (spaceBelow >= tipHeight + 14) {
            top = rect.bottom + 10;
            isBelow = true;
        } else {
            if (spaceBelow > spaceAbove) {
                top = rect.bottom + 10;
                isBelow = true;
            } else {
                top = rect.top - tipHeight - 10;
                isBelow = false;
            }
        }

        // Clamp vertically so tooltip NEVER clips off top or bottom
        const minTop = 10;
        const maxTop = Math.max(minTop, viewportHeight - tipHeight - 10);
        top = Math.max(minTop, Math.min(top, maxTop));

        // Horizontal position: Centered on circle & clamped to screen
        let left = (rect.left + (rect.width / 2)) - (tipWidth / 2);
        const minLeft = 14;
        const maxLeft = Math.max(minLeft, viewportWidth - tipWidth - 14);
        left = Math.max(minLeft, Math.min(left, maxLeft));

        tip.style.top = `${Math.round(top)}px`;
        tip.style.left = `${Math.round(left)}px`;

        const circleCenterX = rect.left + (rect.width / 2);
        let arrowOffset = circleCenterX - left;
        arrowOffset = Math.max(12, Math.min(tipWidth - 12, arrowOffset));

        if (isBelow) {
            arrowEl.style.top = '-5px';
            arrowEl.style.bottom = 'auto';
            arrowEl.style.borderBottom = 'none';
            arrowEl.style.borderRight = 'none';
            arrowEl.style.borderTop = '1px solid rgba(255, 255, 255, 0.2)';
            arrowEl.style.borderLeft = '1px solid rgba(255, 255, 255, 0.2)';
        } else {
            arrowEl.style.top = 'auto';
            arrowEl.style.bottom = '-5px';
            arrowEl.style.borderTop = 'none';
            arrowEl.style.borderLeft = 'none';
            arrowEl.style.borderBottom = '1px solid rgba(255, 255, 255, 0.2)';
            arrowEl.style.borderRight = '1px solid rgba(255, 255, 255, 0.2)';
        }
        arrowEl.style.left = `${Math.round(arrowOffset - 5)}px`;

        requestAnimationFrame(() => {
            tip.style.opacity = '1';
            tip.style.transform = 'scale(1)';
        });
    }

    function hideTooltip(immediate) {
        if (hideTimer) clearTimeout(hideTimer);
        const performHide = () => {
            if (!tooltipEl) return;
            tooltipEl.style.opacity = '0';
            tooltipEl.style.transform = 'scale(0.96)';
            setTimeout(() => {
                if (tooltipEl && tooltipEl.style.opacity === '0') {
                    tooltipEl.style.display = 'none';
                    activeCircle = null;
                }
            }, 160);
        };

        if (immediate) {
            performHide();
        } else {
            hideTimer = setTimeout(performHide, 120);
        }
    }

    // Delegated event listeners for all current and future .info-circle elements
    document.addEventListener('mouseover', function(e) {
        const circle = e.target.closest('.info-circle');
        if (circle) {
            showTooltipFor(circle);
        }
    });

    document.addEventListener('mouseout', function(e) {
        const circle = e.target.closest('.info-circle');
        if (circle) {
            hideTooltip(false);
        }
    });

    document.addEventListener('click', function(e) {
        const circle = e.target.closest('.info-circle');
        if (circle) {
            e.stopPropagation();
            if (activeCircle === circle && tooltipEl && tooltipEl.style.display === 'block' && tooltipEl.style.opacity === '1') {
                hideTooltip(true);
            } else {
                showTooltipFor(circle);
            }
        } else if (tooltipEl && !tooltipEl.contains(e.target)) {
            hideTooltip(true);
        }
    });

    window.addEventListener('scroll', function() {
        if (activeCircle) hideTooltip(true);
    }, { passive: true });

    window.addEventListener('resize', function() {
        if (activeCircle) hideTooltip(true);
    });
})();
