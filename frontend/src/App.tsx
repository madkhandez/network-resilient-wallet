import { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';

const INACTIVITY_LIMIT_MS = 15 * 60 * 1000; // 15 minutes

const AuthGuard = ({ children }: { children: React.ReactNode }) => {
  const token = localStorage.getItem('jwt');
  const navigate = useNavigate();

  useEffect(() => {
    if (!token) return;

    const checkInactivity = () => {
      const lastActive = localStorage.getItem('last_active');
      if (lastActive && Date.now() - parseInt(lastActive, 10) > INACTIVITY_LIMIT_MS) {
        localStorage.removeItem('jwt');
        localStorage.removeItem('last_active');
        navigate('/login');
      }
    };

    const updateActivity = () => {
      localStorage.setItem('last_active', Date.now().toString());
    };

    // Initial check
    checkInactivity();
    updateActivity();

    const interval = setInterval(checkInactivity, 60000); // Check every minute
    
    const events = ['click', 'keypress', 'scroll', 'touchstart'];
    events.forEach(e => window.addEventListener(e, updateActivity));

    return () => {
      clearInterval(interval);
      events.forEach(e => window.removeEventListener(e, updateActivity));
    };
  }, [token, navigate]);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
};

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route 
          path="/" 
          element={
            <AuthGuard>
              <Dashboard />
            </AuthGuard>
          } 
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
