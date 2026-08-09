const nodemailer = require('nodemailer');

// Configure email transporter
const getTransporter = () => {
  // Option 1: Using Gmail
  const gmailEmail = process.env.GMAIL_EMAIL;
  const gmailPassword = process.env.GMAIL_PASSWORD;

  // Option 2: Using SMTP
  const smtpUser = process.env.SMTP_USER || gmailEmail;
  const smtpPass = process.env.SMTP_PASS || gmailPassword;

  // Check if credentials are available
  if (!smtpUser || !smtpPass) {
    console.warn('⚠️  Email credentials not configured. Email functionality will be disabled.');
    return null;
  }

  const smtpConfig = {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  };

  return nodemailer.createTransport(smtpConfig);
};

const transporter = getTransporter();

/**
 * Send redemption email
 */
const sendRedemptionEmail = async (emailData) => {
  const {
    to,
    subject,
    rewardName,
    rewardDescription,
    category,
    pointsRequired,
    studentEmail,
    studentPhone,
    deliveryAddress,
    studentIdUrl,
    redemptionDate,
    redemptionId,
  } = emailData;

  // Validate required fields
  if (!to || !subject || !rewardName) {
    throw new Error('Missing required email fields: to, subject, rewardName');
  }

  // Create HTML email template
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
          .info-box { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #667eea; }
          .label { font-weight: bold; color: #667eea; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🎁 New Reward Redemption</h2>
          </div>
          <div class="content">
            <div class="info-box">
              <div class="label">Reward Name:</div>
              <div>${rewardName}</div>
            </div>
            
            <div class="info-box">
              <div class="label">Description:</div>
              <div>${rewardDescription || 'N/A'}</div>
            </div>
            
            <div class="info-box">
              <div class="label">Category:</div>
              <div>${category}</div>
            </div>
            
            <div class="info-box">
              <div class="label">Points Required:</div>
              <div>${pointsRequired} points</div>
            </div>
            
            <h3 style="color: #667eea; margin-top: 20px;">Student Information</h3>
            
            <div class="info-box">
              <div class="label">Email:</div>
              <div><a href="mailto:${studentEmail}">${studentEmail}</a></div>
            </div>
            
            <div class="info-box">
              <div class="label">Phone:</div>
              <div><a href="tel:${studentPhone}">${studentPhone}</a></div>
            </div>
            
            <div class="info-box">
              <div class="label">Delivery Address:</div>
              <div>${deliveryAddress || 'N/A'}</div>
            </div>
            
            ${studentIdUrl ? `
            <div class="info-box">
              <div class="label">Student ID:</div>
              <div><a href="${studentIdUrl}" target="_blank">View Student ID</a></div>
            </div>
            ` : ''}
            
            <div class="info-box">
              <div class="label">Redemption Date:</div>
              <div>${redemptionDate}</div>
            </div>
            
            <div class="info-box">
              <div class="label">Redemption ID:</div>
              <div>${redemptionId}</div>
            </div>
            
            <div class="footer">
              <p>This is an automated notification from Truesight University Rewards System.</p>
              <p>Please process this redemption and update the status in the admin panel.</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  // Plain text version
  const textContent = `
New Reward Redemption

Reward: ${rewardName}
Description: ${rewardDescription || 'N/A'}
Category: ${category}
Points Required: ${pointsRequired}

Student Information:
Email: ${studentEmail}
Phone: ${studentPhone}
Delivery Address: ${deliveryAddress || 'N/A'}
Student ID: ${studentIdUrl || 'N/A'}

Redemption Date: ${redemptionDate}
Redemption ID: ${redemptionId}

This is an automated notification from Truesight University Rewards System.
  `;

  // Check if transporter is configured
  if (!transporter) {
    throw new Error('Email service not configured. Please set GMAIL_EMAIL/GMAIL_PASSWORD or SMTP_USER/SMTP_PASS in .env');
  }

  // Check if transporter is configured
  if (!transporter) {
    throw new Error('Email service not configured. Please set GMAIL_EMAIL/GMAIL_PASSWORD or SMTP_USER/SMTP_PASS in .env');
  }

  // Send email
  const mailOptions = {
    from: `"Truesight University" <${process.env.GMAIL_EMAIL || process.env.SMTP_USER}>`,
    to: to,
    subject: subject,
    text: textContent,
    html: htmlContent,
  };

  const info = await transporter.sendMail(mailOptions);
  return {
    success: true,
    messageId: info.messageId,
    message: 'Email sent successfully',
  };
};

/**
 * Send password reset OTP email
 */
const sendPasswordResetOTP = async (emailData) => {
  const { email, userId, otp, expiresAt } = emailData;

  if (!email || !userId || !otp) {
    throw new Error('Missing required fields: email, userId, otp');
  }

  const appUrl = process.env.APP_URL || 'http://localhost:3000';

  // Create HTML email template
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .otp-box { background: white; padding: 20px; margin: 20px 0; border-radius: 8px; text-align: center; border: 2px dashed #667eea; }
          .otp-code { font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 8px; font-family: 'Courier New', monospace; }
          .info-box { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #667eea; }
          .warning { background: #fff3cd; border-left-color: #ffc107; padding: 15px; margin: 15px 0; border-radius: 5px; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>🔐 Password Reset OTP</h2>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p>An administrator has initiated a password reset for your account. Use the OTP below to reset your password:</p>
            
            <div class="otp-box">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your OTP Code:</p>
              <div class="otp-code">${otp}</div>
            </div>

            <div class="warning">
              <strong>⚠️ Important:</strong>
              <ul style="margin: 10px 0; padding-left: 20px;">
                <li>This OTP is valid for 10 minutes only</li>
                <li>Do not share this OTP with anyone</li>
                <li>If you didn't request this, please ignore this email</li>
              </ul>
            </div>

            <div class="info-box">
              <p style="margin: 0;"><strong>Next Steps:</strong></p>
              <ol style="margin: 10px 0; padding-left: 20px;">
                <li>Click the link below or go to the password reset page</li>
                <li>Enter your email and the OTP code</li>
                <li>Set your new password</li>
              </ol>
              <div style="text-align: center; margin-top: 20px;">
                <a href="${appUrl}/resetpassword-otp?email=${encodeURIComponent(email)}" 
                   style="display: inline-block; background: #667eea; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">
                  Reset Password
                </a>
              </div>
            </div>
            
            <div class="footer">
              <p>This is an automated email from Truesight University.</p>
              <p>If you have any concerns, please contact support immediately.</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  // Plain text version
  const textContent = `
Password Reset OTP

An administrator has initiated a password reset for your account.

Your OTP Code: ${otp}

This OTP is valid for 10 minutes only.

Important:
- Do not share this OTP with anyone
- If you didn't request this, please ignore this email

Next Steps:
1. Go to: ${appUrl}/resetpassword-otp?email=${encodeURIComponent(email)}
2. Enter your email and the OTP code
3. Set your new password

This is an automated email from Truesight University.
  `;

  // Check if transporter is configured
  if (!transporter) {
    throw new Error('Email service not configured. Please set GMAIL_EMAIL/GMAIL_PASSWORD or SMTP_USER/SMTP_PASS in .env');
  }

  // Send email
  const mailOptions = {
    from: `"Truesight University" <${process.env.GMAIL_EMAIL || process.env.SMTP_USER}>`,
    to: email,
    subject: 'Password Reset OTP - Truesight University',
    text: textContent,
    html: htmlContent,
  };

  const info = await transporter.sendMail(mailOptions);
  return {
    success: true,
    messageId: info.messageId,
    message: 'OTP sent successfully to user email',
  };
};

/**
 * Send challenge invitation email
 */
const sendChallengeInvitation = async (emailData) => {
  const { 
    to, 
    challengerName, 
    topic, 
    challengeId,
    expiresAt,
    appUrl 
  } = emailData;

  if (!to || !challengerName || !topic) {
    throw new Error('Missing required fields: to, challengerName, topic');
  }

  const appBaseUrl = appUrl || process.env.APP_URL || 'http://localhost:3000';
  const challengeLink = `${appBaseUrl}/challenges/${challengeId}`;
  const expiresDate = expiresAt ? new Date(expiresAt).toLocaleString() : '24 hours from now';

  // Create HTML email template
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 8px 8px 0 0; text-align: center; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .challenge-box { background: white; padding: 25px; margin: 20px 0; border-radius: 8px; border: 2px solid #667eea; text-align: center; }
          .topic { font-size: 24px; font-weight: bold; color: #667eea; margin: 15px 0; }
          .info-box { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; border-left: 4px solid #667eea; }
          .label { font-weight: bold; color: #667eea; }
          .cta-button { display: inline-block; background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🏆 Quiz Challenge Invitation</h1>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p><strong>${challengerName}</strong> has challenged you to a quiz battle!</p>
            
            <div class="challenge-box">
              <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Topic:</p>
              <div class="topic">${topic}</div>
              <p style="margin: 10px 0; color: #666;">Test your knowledge and compete for bonus points!</p>
            </div>

            <div class="info-box">
              <p style="margin: 0;"><strong>Challenge Details:</strong></p>
              <ul style="margin: 10px 0; padding-left: 20px;">
                <li><span class="label">Challenger:</span> ${challengerName}</li>
                <li><span class="label">Topic:</span> ${topic}</li>
                <li><span class="label">Expires:</span> ${expiresDate}</li>
                <li><span class="label">Type:</span> Asynchronous (Complete at your own pace)</li>
              </ul>
            </div>

            <div style="text-align: center; margin: 30px 0;">
              <a href="${challengeLink}" class="cta-button">Accept Challenge</a>
            </div>

            <div class="info-box">
              <p style="margin: 0;"><strong>How it works:</strong></p>
              <ol style="margin: 10px 0; padding-left: 20px;">
                <li>Click the button above or log in to your account</li>
                <li>Go to the Challenges page</li>
                <li>Accept the challenge</li>
                <li>Complete the quiz (you have 24 hours)</li>
                <li>Winner gets 2x bonus points!</li>
              </ol>
            </div>
            
            <div class="footer">
              <p>This is an automated invitation from Truesight University.</p>
              <p>Good luck! 🎯</p>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  // Plain text version
  const textContent = `
Quiz Challenge Invitation

Hello,

${challengerName} has challenged you to a quiz battle!

Topic: ${topic}
Expires: ${expiresDate}
Type: Asynchronous (Complete at your own pace)

Accept the challenge: ${challengeLink}

How it works:
1. Click the link above or log in to your account
2. Go to the Challenges page
3. Accept the challenge
4. Complete the quiz (you have 24 hours)
5. Winner gets 2x bonus points!

This is an automated invitation from Truesight University.
Good luck!
  `;

  // Check if transporter is configured
  if (!transporter) {
    throw new Error('Email service not configured. Please set GMAIL_EMAIL/GMAIL_PASSWORD or SMTP_USER/SMTP_PASS in .env');
  }

  // Send email
  const mailOptions = {
    from: `"Truesight University" <${process.env.GMAIL_EMAIL || process.env.SMTP_USER}>`,
    to: to,
    subject: `🏆 Quiz Challenge: ${topic} - ${challengerName} has challenged you!`,
    text: textContent,
    html: htmlContent,
  };

  const info = await transporter.sendMail(mailOptions);
  return {
    success: true,
    messageId: info.messageId,
    message: 'Challenge invitation email sent successfully',
  };
};

module.exports = {
  sendRedemptionEmail,
  sendPasswordResetOTP,
  sendChallengeInvitation,
};

