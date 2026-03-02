const nodemailer = require('nodemailer');

// The transporter setup remains the same, using environment variables
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: Number(process.env.SMTP_PORT) === 465, // true for 465, false for others
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// --- EMAIL CONTENT DEFINITIONS ---

// 1. BRAND Welcome Email Content (Reconstructed from earlier request)
const BRAND_EMAIL_CONTENT = {
  subject: `Welcome to CollabGlam🚀`,
  htmlTemplate: (name) => `
    <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 16px; overflow: hidden; background-color: #ffffff;">
      <!-- Header: Brand Focused (Darker Blue) -->
      <div style=" padding: 20px; text-align: center;">
        <h2 style="margin: 0; font-size: 24px;">CollabGlam Brand Welcome</h2>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);"></div>
      <!-- Body -->
      <div style="padding: 30px; line-height: 1.6; color: #333;">
        <p style="font-size: 16px;">Hi <strong>${name}</strong>,</p>
        
        <p>Welcome to CollabGlam, where your brand meets the right creators to grow, engage, and shine! 🌟</p>

        <p>Your registration is successful, and your brand dashboard is ready. With CollabGlam, you can:</p>
        <ul style="list-style-type: none; padding-left: 0; margin: 20px 0;">
            <li style="margin-bottom: 10px; padding-left: 25px; position: relative;">
                <span style="color: #27ae60; font-weight: bold; font-size: 1.2em; position: absolute; left: 0;">&#10004;</span> Discover verified influencers that match your niche.
            </li>
            <li style="margin-bottom: 10px; padding-left: 25px; position: relative;">
                <span style="color: #27ae60; font-weight: bold; font-size: 1.2em; position: absolute; left: 0;">&#10004;</span> Launch and manage influencer campaigns easily.
            </li>
            <li style="margin-bottom: 10px; padding-left: 25px; position: relative;">
                <span style="color: #27ae60; font-weight: bold; font-size: 1.2em; position: absolute; left: 0;">&#10004;</span> Track campaign performance and engagement in real time.
            </li>
        </ul>


        <!-- Call to Action Button -->
        <div style="text-align: center; margin: 30px 0;">
            <a href="https://collabglam.com/brand/add-edit-campaign" 
               style="background-color: #FF6A00; color: white; padding: 12px 25px; 
                      text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px; display: inline-block;">
                Create Your First Campaign
            </a>
        </div>

        <!-- Support Section -->
        <p style="margin-top: 30px;">Need help getting started? Visit our 
            contact us at 
            <a href="mailto:support@collabglam.com" style="color: #3498db; text-decoration: none;">support@collabglam.com</a> — our team is happy to assist you anytime.
        </p>

        <p style="margin-top: 40px;">Let’s build campaigns that inspire! 💫</p>

        <p>Warm regards,<br/>
        <strong>Team CollabGlam</strong></p>

        <p style="font-size: 12px; color: #7f8c8d; border-top: 1px solid #ecf0f1; padding-top: 10px;">
            <em>*Connecting Brands with Authentic Influencers*</em>
        </p>
      </div>
    </div>
  `,
};


// 2. INFLUENCER Welcome Email Content (Currently in file)
const INFLUENCER_EMAIL_CONTENT = {
  subject: `Welcome to CollabGlam — Let’s Begin Your Creator Journey 🌈`,
  htmlTemplate: (name) => `
    <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 16px; overflow: hidden; background-color: #ffffff;">
      <!-- Header: Influencer Focused (Lighter Blue) -->
      <div style="padding: 20px; text-align: center;">
        <h2 style="margin: 0; font-size: 24px;">CollabGlam Influencer Welcome</h2>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#FF6A00 0%, #FF8A00 30%, #FF9A00 60%, #FFBF00 100%);"></div>
      <!-- Body -->
      <div style="padding: 30px; line-height: 1.6; color: #333;">
        <p style="font-size: 16px;">Hi <strong>${name}</strong>,</p>

        <p>Welcome to CollabGlam — a community built to help creators like you connect, collaborate, and grow! 🎬✨</p>

        <p style="font-weight: bold; margin-top: 25px;">Your influencer profile is your key to brand partnerships. Here’s what you can do now:</p>
        
        <ul style="list-style-type: none; padding-left: 0; margin: 20px 0;">
            <li style="margin-bottom: 12px; padding-left: 30px; position: relative;">
                <span style="color: #f1c40f; font-weight: bold; font-size: 1.5em; position: absolute; left: 0; line-height: 1;">&#9733;</span> Build your media kit and showcase your profile.
            </li>
            <li style="margin-bottom: 12px; padding-left: 30px; position: relative;">
                <span style="color: #e74c3c; font-weight: bold; font-size: 1.5em; position: absolute; left: 0; line-height: 1;">&#127919;</span> Apply to campaigns that match your niche and interests.
            </li>
            <li style="margin-bottom: 12px; padding-left: 30px; position: relative;">
                <span style="color: #2ecc71; font-weight: bold; font-size: 1.5em; position: absolute; left: 0; line-height: 1;">&#128176;</span> Collaborate with trusted brands and grow your earnings.
            </li>
        </ul>

        <!-- Call to Action Button -->
        <div style="text-align: center; margin: 30px 0;">
            <a href="https://collabglam.com/influencer/new-collab" 
               style="background-color: #FF9A00; color: white; padding: 12px 25px; 
                      text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px; display: inline-block;">
                Browse Campaigns
            </a>
        </div>

        <!-- Support Section -->
        <p style="margin-top: 30px;">Need any guidance? We’re always here to help. Visit our 
            email 
            <a href="mailto:support@collabglam.com" style="color: #3498db; text-decoration: none;">support@collabglam.com</a>.
        </p>

        <p style="margin-top: 40px;">Here’s to your next big collaboration — and beyond! 💖</p>

        <p>Cheers,<br/>
        <strong>Team CollabGlam</strong></p>

        <p style="font-size: 12px; color: #7f8c8d; border-top: 1px solid #ecf0f1; padding-top: 10px;">
            <em>*Empowering Creators. Connecting Opportunities.*</em>
        </p>
      </div>
    </div>
  `,
};

/**
 * Sends a welcome email based on the user's registration type (brand or influencer).
 * Requires 'email', 'name', and 'userType' in the request body.
 */
exports.sendWelcomeEmail = async (req, res) => {
  let emailContent;

  try {
    // Expecting 'userType' in addition to 'email' and 'name'
    const { email, name, userType } = req.body;

    if (!email || !name || !userType) {
      return res.status(400).json({ message: "Email, name, and userType ('brand' or 'influencer') are required" });
    }

    // Conditional logic to select the correct template
    switch (userType.toLowerCase()) {
      case 'brand':
        emailContent = BRAND_EMAIL_CONTENT;
        break;
      case 'influencer':
        emailContent = INFLUENCER_EMAIL_CONTENT;
        break;
      default:
        return res.status(400).json({ message: "Invalid userType. Must be 'brand' or 'influencer'." });
    }

    // Define the email content using the selected template
    const mailOptions = {
      from: `"CollabGlam" <${process.env.SMTP_USER}>`,
      to: email,
      subject: emailContent.subject,
      html: emailContent.htmlTemplate(name), // Pass the name to the template function
    };

    // Send email
    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: `CollabGlam welcome email sent to ${userType} ${name} at ${email}` });
  } catch (error) {
    console.error("CollabGlam welcome email sending failed:", error);
    res.status(500).json({ message: "Failed to send welcome email for registration", error });
  }
};