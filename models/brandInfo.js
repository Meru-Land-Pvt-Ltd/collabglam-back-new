const mongoose = require("mongoose");
const crypto = require("crypto");

const BrandSchema = new mongoose.Schema(
  {
    brand_id: {
      type: String,
      default: () => crypto.randomUUID(),
      unique: true,
      index: true,
    },

    normalized_brand_name: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },

    input_brand_name: {
      type: String,
      required: true,
      trim: true,
    },

    brand_name: {
      type: String,
      required: true,
      trim: true,
    },

    brand_alias: { type: String, default: null },
    domain: { type: String, default: null },
    website_url: { type: String, default: null },
    logo_url: { type: String, default: null },
    brand_description: { type: String, default: null },
    industry: { type: String, default: null },
    sub_industry: { type: String, default: null },
    brand_category: { type: String, default: null },
    company_type: { type: String, default: null },
    business_model: { type: String, default: null },
    founded_year: { type: String, default: null },
    headquarters_city: { type: String, default: null },
    headquarters_state: { type: String, default: null },
    headquarters_country: { type: String, default: null },
    operating_regions: { type: String, default: null },

    last_year_revenue: { type: String, default: null },
    last_year_revenue_year: { type: String, default: null },
    employee_count: { type: String, default: null },
    company_size_category: { type: String, default: null },
    annual_revenue: { type: String, default: null },
    revenue_range: { type: String, default: null },
    funding_total: { type: String, default: null },
    funding_stage: { type: String, default: null },
    valuation: { type: String, default: null },
    profitability_status: { type: String, default: null },
    growth_rate: { type: String, default: null },
    brand_maturity: { type: String, default: null },

    instagram_url: { type: String, default: null },
    instagram_followers: { type: String, default: null },
    instagram_engagement_rate: { type: String, default: null },
    youtube_url: { type: String, default: null },
    youtube_subscribers: { type: String, default: null },
    linkedin_url: { type: String, default: null },
    facebook_url: { type: String, default: null },
    twitter_url: { type: String, default: null },
    website_traffic_monthly: { type: String, default: null },
    app_downloads: { type: String, default: null },

    primary_contact_name: { type: String, default: null },
    contact_designation: { type: String, default: null },
    contact_email: { type: String, default: null },
    contact_phone: { type: String, default: null },
    linkedin_contact_url: { type: String, default: null },
    contact_department: { type: String, default: null },

    about_page_url: { type: String, default: null },
    contact_page_url: { type: String, default: null },
    general_email: { type: String, default: null },
    sales_email: { type: String, default: null },
    support_email: { type: String, default: null },
    public_phone: { type: String, default: null },
    public_address: { type: String, default: null },

    website_pages_scraped: [{ type: String }],
    last_scraped_at: { type: Date, default: null },


  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("BrandInfo", BrandSchema);