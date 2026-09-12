import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../api';

interface Profile {
  email: string;
  balance: number;
}

export default function Dashboard() {
  const navigate = useNavigate();

  const { data: profile, isLoading, error } = useQuery<Profile, ApiError>({
    queryKey: ['profile'],
    queryFn: () => apiFetch('/me'),
  });

  const handleLogout = () => {
    localStorage.removeItem('jwt');
    localStorage.removeItem('last_active');
    navigate('/login');
  };

  if (isLoading) {
    return <div className="loading">Loading...</div>;
  }

  if (error) {
    return (
      <div className="error-container">
        <p>Failed to load profile data. Are you offline?</p>
        <button onClick={handleLogout}>Logout</button>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1>Hello {profile?.email}, welcome back</h1>
        <button onClick={handleLogout} className="logout-btn">Logout</button>
      </header>
      
      <main className="dashboard-main">
        <div className="balance-card">
          <h2>Your Balance</h2>
          <p className="balance-amount">
            ${((profile?.balance || 0) / 100).toFixed(2)}
          </p>
        </div>
      </main>
    </div>
  );
}
