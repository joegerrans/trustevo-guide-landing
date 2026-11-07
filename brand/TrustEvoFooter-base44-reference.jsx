import React from "react";
import { Link } from "react-router-dom";
import { Shield } from "lucide-react";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";

/**
 * TrustEvo site footer.
 * Standalone and portable: only needs `react-router-dom`, `lucide-react`,
 * the createPageUrl helper and the base44 client.
 *
 * Props:
 *  - isAdviser       shows the Adviser Login link when true
 *  - onContactClick  opens the "Contact" booking modal
 */
export default function TrustEvoFooter({ isAdviser = false, onContactClick }) {
  return (
    <footer className="bg-[#0A2339] text-white border-t border-white/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-12 mb-16">
          {/* Logo & Description */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-3.5 mb-7">
              <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-[#123C5A] to-[#0A2339] flex items-center justify-center border border-[#0ABF9E]/30">
                <svg width="26" height="26" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M10 2L3 6V10C3 14.5 6 17.5 10 18C14 17.5 17 14.5 17 10V6L10 2Z" fill="none" stroke="#0ABF9E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M7 10L9 12L13 8" stroke="#0ABF9E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="text-[30px] font-bold leading-none" style={{fontFamily: 'DM Serif Display, serif', letterSpacing: '-0.015em'}}>
                <span className="text-white">Trust</span><span className="text-[#0ABF9E]">Evo</span>
              </div>
            </div>
            <p className="text-gray-300 leading-relaxed text-[16px] mb-4 max-w-md">
              Connecting you with trusted, FCA-authorised financial advisers. Safe, secure, and jargon-free guidance when you need it most.
            </p>
            <p className="text-xs text-gray-500 leading-relaxed max-w-md">
              TrustEvo helps individuals explore their financial planning options and, where appropriate, connect with FCA-authorised financial advisers. TrustEvo does not provide regulated financial advice.
            </p>
          </div>

          {/* Quick Links */}
          <div>
          <h3 className="font-semibold text-white mb-6 text-[15px] tracking-wide">Quick Links</h3>
          <ul className="space-y-3">
            <li><Link to={createPageUrl("Home")} onClick={() => window.scrollTo(0, 0)} className="text-gray-400 hover:text-white transition-colors text-[16px]">Home</Link></li>
            <li><a href="/#how-it-works" className="text-gray-400 hover:text-white transition-colors text-[16px]">How It Works</a></li>
            <li><Link to={createPageUrl("About")} className="text-gray-400 hover:text-white transition-colors text-[16px]">About</Link></li>
            <li><Link to={createPageUrl("Insights")} className="text-gray-400 hover:text-white transition-colors text-[16px]">Insights</Link></li>
            <li><Link to={createPageUrl("FAQ")} className="text-gray-400 hover:text-white transition-colors text-[16px]">FAQ's</Link></li>
            <li><button onClick={onContactClick} className="text-gray-400 hover:text-white transition-colors text-[16px] text-left">Contact</button></li>
            <li><a href="https://register.fca.org.uk" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-white transition-colors text-[16px]">Verify any adviser on the FCA Register →</a></li>
          </ul>
          </div>

          {/* Legal */}
          <div>
            <h3 className="font-semibold text-white mb-6 text-[15px] tracking-wide">Legal</h3>
            <ul className="space-y-3">
              <li><Link to={createPageUrl("Privacy")} className="text-gray-400 hover:text-white transition-colors text-[16px]">Privacy</Link></li>
              <li><Link to={createPageUrl("Terms")} className="text-gray-400 hover:text-white transition-colors text-[16px]">Terms</Link></li>
              <li><Link to={createPageUrl("Complaints")} className="text-gray-400 hover:text-white transition-colors text-[16px]">Complaints</Link></li>
              <li><button onClick={() => { localStorage.setItem('trustevo_reopen_cookie_settings', 'true'); window.dispatchEvent(new Event('reopenCookieSettings')); }} className="text-gray-400 hover:text-white transition-colors text-[16px] text-left">Cookie Settings</button></li>
              {isAdviser && (
                <li><button onClick={() => base44.auth.redirectToLogin(createPageUrl("Adviser-Portal"))} className="text-gray-400 hover:text-white transition-colors text-[16px] text-left">Adviser Login</button></li>
              )}
            </ul>
          </div>
        </div>

        <div className="border-t border-white/5 pt-10">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4 mb-4">
            <p className="text-gray-500 text-sm">
              © {new Date().getFullYear()} Nuvevo Ltd. All rights reserved.
            </p>
            <div className="flex items-center gap-6">
              <Shield className="w-4 h-4 text-gray-600" />
              <span className="text-xs text-gray-500">FCA-Regulated Adviser Network</span>
            </div>
          </div>

          <p className="text-xs text-gray-400 leading-relaxed mb-3">
            TrustEvo is an introducer of FCA-authorised financial advisers. TrustEvo does not provide regulated financial advice.
          </p>
          <div className="text-xs text-gray-500 leading-relaxed space-y-0.5">
            <p>TrustEvo is a trading name of Nuvevo Ltd.</p>
            <p>Registered in England & Wales.</p>
            <p>Company No: 16802797.</p>
            <p>Registered office: 59 Wharley Hook, Harlow, Essex, CM18 7DP.</p>
            <p>Phone: 01923 911242</p>
          </div>
        </div>
      </div>
    </footer>
  );
}