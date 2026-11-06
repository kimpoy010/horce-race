<?php

namespace Tests\Feature;

/** the `staff` command: every action works for the operator console (/admin) and for a client's back office (/backoffice) */
class StaffCommandTest extends StaffTestCase
{
    public function test_an_operator_password_can_be_reset_by_its_name(): void
    {
        $this->staff('_operator', 'administrator');
        [$h] = $this->signIn('admin', null, 'administrator');
        $this->artisan('staff', ['action' => 'reset-operator-password', 'a' => 'administrator'])->expectsOutputToContain('Temporary password for administrator:')->assertSuccessful();
        $this->getJson('/admin/api/me', $h)->assertStatus(401);                       // signed out everywhere
        $this->postJson('/admin/api/login', ['username' => 'administrator', 'password' => self::PW], ['Origin' => rtrim(config('app.url'), '/')])->assertStatus(401);   // the old password is gone
        $this->assertTrue((bool) $this->users->get('_operator', 'administrator')->must_change, 'the new password must be changed at the first sign-in');
    }

    public function test_a_client_staff_password_can_be_reset_with_the_client_id(): void
    {
        $this->staff('acme', 'ann');
        $this->artisan('staff', ['action' => 'reset-password', 'a' => 'acme', 'b' => 'ann'])->expectsOutputToContain('Temporary password for ann:')->assertSuccessful();
        $this->assertTrue((bool) $this->users->get('acme', 'ann')->must_change);
    }

    public function test_operators_can_be_listed_added_disabled_and_enabled(): void
    {
        $this->artisan('staff', ['action' => 'add-operator', 'a' => 'olga', '--role' => 'support'])->expectsOutputToContain('created olga (support)')->assertSuccessful();
        $this->artisan('staff', ['action' => 'list-operators'])->expectsOutputToContain('olga')->assertSuccessful();
        $this->artisan('staff', ['action' => 'disable-operator', 'a' => 'olga'])->expectsOutputToContain('olga disabled')->assertSuccessful();
        $this->artisan('staff', ['action' => 'enable-operator', 'a' => 'olga'])->expectsOutputToContain('olga enabled')->assertSuccessful();
        $this->artisan('staff', ['action' => 'reset-operator-password', 'a' => 'nobody'])->assertFailed();
    }
}
