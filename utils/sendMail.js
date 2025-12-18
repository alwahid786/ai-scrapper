import sgMail from '@sendgrid/mail';
import { getEnv } from '../config/config.js';

sgMail.setApiKey(getEnv('SENDGRID_API_KEY'));

const sendMail = async (to, subject, text, html = false, attachments) => {
  try {
    if (!to || !subject || !text) {
      throw new Error('Please Provide To, Subject and Text');
    }

    const msg = {
      from: getEnv('SENDGRID_MAIL_FROM'),
      to,
      subject,
      text: html ? undefined : text,
      html: html ? text : undefined,
      attachments: attachments?.map((file) => ({
        filename: file.filename,
        content: Buffer.isBuffer(file.content)
          ? file.content.toString('base64')
          : Buffer.from(file.content).toString('base64'),
        type: file.contentType || file.type || 'application/pdf',
        disposition: 'attachment',
      })),
    };

    const response = await sgMail.send(msg);
    console.log('SendGrid response:', response);
    return true;
  } catch (error) {
    console.error('Error while sending mail', error);
    return false;
  }
};

export { sendMail };
