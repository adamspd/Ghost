const logging = require('@tryghost/logging');
const errors = require('@tryghost/errors');
const debug = require('@tryghost/debug')('email-service:smtp-provider-service');

/**
 * @typedef {object} Recipient
 * @prop {string} email
 * @prop {Replacement[]} replacements
 */

/**
 * @typedef {object} Replacement
 * @prop {string} token
 * @prop {string} value
 * @prop {string} id
 */

/**
 * @typedef {object} EmailSendingOptions
 * @prop {boolean} clickTrackingEnabled
 * @prop {boolean} openTrackingEnabled
 * @prop {Date} deliveryTime
 */

/**
 * @typedef {object} EmailProviderSuccessResponse
 * @prop {string} id
 */

class SMTPEmailProvider {
    #ghostMailer;
    #errorHandler;

    /**
     * @param {object} dependencies
     * @param {object} dependencies.ghostMailer - Ghost mailer instance for SMTP sending
     * @param {Function} [dependencies.errorHandler] - custom error handler for logging exceptions
     */
    constructor({
        ghostMailer,
        errorHandler
    }) {
        this.#ghostMailer = ghostMailer;
        this.#errorHandler = errorHandler;
    }

    /**
     * Replace template variables in content with actual values for each recipient
     * @param {string} content
     * @param {Replacement[]} replacements
     * @returns {string}
     */
    #applyReplacements(content, replacements) {
        let result = content;
        replacements.forEach(replacement => {
            result = result.replace(new RegExp(replacement.token, 'g'), replacement.value);
        });
        return result;
    }

    /**
     * Send an email using SMTP
     * @param {import('./SendingService').EmailData} data
     * @param {EmailSendingOptions} options
     * @returns {Promise<EmailProviderSuccessResponse>}
     */
    async send(data, options) {
        const {
            subject,
            html,
            plaintext,
            from,
            replyTo,
            emailId,
            recipients,
            replacementDefinitions
        } = data;

        logging.info(`[SMTP Provider] Sending email to ${recipients.length} recipients`);

        try {
            // For SMTP, we need to send individual emails to each recipient
            // since SMTP doesn't have native batch sending with per-recipient variables
            const sendPromises = recipients.map(async (recipient) => {
                // Apply replacements for this specific recipient
                let personalizedHtml = html;
                let personalizedPlaintext = plaintext;
                let personalizedSubject = subject;

                // Apply recipient-specific replacements
                if (recipient.replacements && recipient.replacements.length > 0) {
                    recipient.replacements.forEach(replacement => {
                        personalizedHtml = personalizedHtml.replace(new RegExp(replacement.token, 'g'), replacement.value);
                        personalizedPlaintext = personalizedPlaintext.replace(new RegExp(replacement.token, 'g'), replacement.value);
                        personalizedSubject = personalizedSubject.replace(new RegExp(replacement.token, 'g'), replacement.value);
                    });
                }

                const message = {
                    to: recipient.email,
                    subject: personalizedSubject,
                    html: personalizedHtml,
                    text: personalizedPlaintext,
                    from: from
                };

                if (replyTo) {
                    message.replyTo = replyTo;
                }

                try {
                    const result = await this.#ghostMailer.send(message);
                    debug(`Email sent successfully to ${recipient.email}`);
                    return { email: recipient.email, success: true, result };
                } catch (error) {
                    logging.error(`Failed to send email to ${recipient.email}: ${error.message}`);
                    if (this.#errorHandler) {
                        this.#errorHandler(error);
                    }
                    return { email: recipient.email, success: false, error: error.message };
                }
            });

            const results = await Promise.allSettled(sendPromises);
            
            // Count successful sends
            const successfulSends = results.filter(result => 
                result.status === 'fulfilled' && result.value.success
            );

            logging.info(`[SMTP Provider] Successfully sent ${successfulSends.length}/${recipients.length} emails`);

            // Return a success response with batch ID (using timestamp + email ID)
            return {
                id: `smtp-${Date.now()}-${emailId || 'unknown'}`
            };

        } catch (error) {
            logging.error(`[SMTP Provider] Batch send failed: ${error.message}`);
            
            if (this.#errorHandler) {
                this.#errorHandler(error);
            }

            throw new errors.EmailError({
                statusCode: 500,
                message: `Failed to send email via SMTP: ${error.message}`,
                help: 'https://ghost.org/docs/concepts/config/#mail',
                context: error.message,
                err: error
            });
        }
    }

    /**
     * Get the maximum number of recipients that can be sent in a single request
     * For SMTP, we'll use a conservative batch size to avoid overwhelming the server
     * @returns {number}
     */
    getMaximumRecipients() {
        return 100; // Conservative batch size for SMTP
    }

    /**
     * Get the target delivery window in milliseconds
     * SMTP sending is typically slower than API-based services
     * @returns {number}
     */
    getTargetDeliveryWindow() {
        return 10 * 60 * 1000; // 10 minutes for SMTP delivery
    }
}

module.exports = SMTPEmailProvider;