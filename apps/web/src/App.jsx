import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import SignInFailureNotice from './components/SignInFailureNotice'
import FlagGate from './components/FlagGate'
import './App.css'

const Landing = lazy(() => import('./pages/Landing'))
const TimerApp = lazy(() => import('./pages/TimerApp'))
const OAuthRedirect = lazy(() => import('./pages/OAuthRedirect'))
const BillingSuccess = lazy(() => import('./pages/BillingSuccess'))
const BillingCancel = lazy(() => import('./pages/BillingCancel'))
const Account = lazy(() => import('./pages/Account'))
const ProActivate = lazy(() => import('./pages/ProActivate'))
const ClubAdmin = lazy(() => import('./pages/ClubAdmin'))
const ClubMagicLink = lazy(() => import('./pages/ClubMagicLink'))

const deferPreload = window.requestIdleCallback || ((cb) => setTimeout(cb, 2000));
deferPreload(() => import('./pages/TimerApp'));

const spinner = (
  <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh'}}>
    <div style={{width:32,height:32,border:'3px solid #e5e7eb',borderTopColor:'#3b82f6',borderRadius:'50%',animation:'spin 0.6s linear infinite'}} />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
  </div>
);

/** A page that does not exist until the `pro` release flag is on. */
const pro = (page) => <FlagGate flag="pro" fallback={spinner}>{page}</FlagGate>;

function App() {
  return (
    <>
    {/* Above the router: the sign-in link carries whatever page it was clicked
        from as `returnTo`, so a failure can come back to any route. */}
    <SignInFailureNotice />
    <Suspense fallback={spinner}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/app" element={<TimerApp />} />
        <Route path="/oauth/redirect" element={<OAuthRedirect />} />
        <Route path="/billing/success" element={<BillingSuccess />} />
        <Route path="/billing/cancel" element={<BillingCancel />} />
        <Route path="/account" element={<Account />} />
        {/* The officer's shareable link. It can only ever land in a browser:
            links open the system browser, never the Zoom sidebar. */}
        <Route path="/pro/:code" element={pro(<ProActivate />)} />
        {/* The officer's console, and the page a mailed admin link lands on.
            Browser-only for the same reason: a magic link cannot open inside
            the Zoom sidebar, and an officer reading their roster is not in a
            meeting. */}
        <Route path="/club/admin" element={pro(<ClubAdmin />)} />
        <Route path="/club/manage" element={pro(<ClubMagicLink />)} />
      </Routes>
    </Suspense>
    </>
  )
}

export default App
